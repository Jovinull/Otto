import { and, eq, gt, gte, inArray, lt, lte, or } from 'drizzle-orm';
import { newThresholds } from '../../domain/budgets/budget';
import type { Stmt } from '../../infrastructure/database/client';
import { commitAtomically } from '../../infrastructure/database/client';
import {
  balanceReconciliations,
  financialTransactions,
  households,
  incomingEvents,
  outgoingMessages,
  pendingActions,
} from '../../infrastructure/database/schema';
import type { LocalClock } from '../../shared/dates';
import {
  addDays,
  addMonths,
  formatShortDate,
  localClock,
  monthName,
  monthRange,
  periodOf,
  weekRange,
} from '../../shared/dates';
import { errorCode, logEvent } from '../../shared/errors';
import { formatBRL } from '../../shared/money';
import { alertStatementsFor } from '../commands/record-transactions';
import type { Deps, Scope } from '../context';
import { loadScope } from '../context';
import { cashFlow, loadBudgetViews, loadCommitments, loadGoals } from '../queries/finance';
import { goalReport, monthReport, periodObservations, weekReport } from '../queries/reports';
import { dueEventsQuery, processEvent } from '../services/inbox';
import { thresholdLabel } from '../services/tone';
import { cardStatement } from '../queries/cards';
import { deliverDueMessages, dueDeliveriesQuery } from './outbox';
import { canStartEvent, hasBudget } from '../../infrastructure/database/metered';

const DAILY_HOUR = 9;
const WEEKLY_HOUR = 8;
const DAY_MS = 86_400_000;
const RETENTION_MS = 90 * DAY_MS;
/** Cada execucao faz pouco trabalho para caber no limite de CPU do plano gratuito. */
const EVENTS_PER_RUN = 4;
const DELIVERIES_PER_RUN = 10;

export async function runRecovery(deps: Deps): Promise<void> {
  // No caso comum nao ha trabalho: uma unica chamada ao banco responde as duas perguntas.
  const [due, deliveries] = await deps.db.batch([
    dueEventsQuery(deps, EVENTS_PER_RUN),
    dueDeliveriesQuery(deps, DELIVERIES_PER_RUN),
  ]);
  if (due.length === 0) {
    await deliverDueMessages(deps, DELIVERIES_PER_RUN, deliveries);
    return;
  }
  for (const { id: eventId } of due) {
    if (!canStartEvent(deps.meter)) break;
    try {
      await processEvent(deps, eventId);
    } catch (error) {
      logEvent('error', 'recovery_failed', { code: errorCode(error) });
    }
  }
  await deliverDueMessages(deps, DELIVERIES_PER_RUN);
}

function enqueue(deps: Deps, scope: Scope, dedupKey: string, text: string): Stmt {
  return deps.db
    .insert(outgoingMessages)
    .values({
      id: deps.newId(),
      householdId: scope.household.id,
      chatId: scope.household.telegramChatId,
      text,
      dedupKey,
      nextAttemptAt: deps.now(),
      createdAt: deps.now(),
    })
    .onConflictDoNothing();
}

async function billReminders(deps: Deps, scope: Scope, clock: LocalClock): Promise<Stmt[]> {
  const ahead = scope.settings.billReminderDaysAhead;
  const targets = new Set([clock.date, addDays(clock.date, ahead)]);
  const periods = [...new Set([...targets].map(periodOf))];
  const groups = await Promise.all(
    periods.map((period) => loadCommitments(deps.db, scope.household.id, period)),
  );
  const due = groups
    .flat()
    .filter(
      (item) =>
        item.kind === 'expense' &&
        !item.settled &&
        item.expected.date !== null &&
        targets.has(item.expected.date),
    );
  const lines = due.map((item) => {
    const value = item.amountCents === null ? 'valor variável' : formatBRL(item.amountCents);
    const when = item.expected.date === clock.date ? 'hoje' : formatShortDate(item.expected.date!);
    return `• ${item.description}: ${value} (${item.expected.approximate ? 'aprox. ' : ''}${when})`;
  });
  // Faturas fechadas com saldo a pagar e vencimento na janela do lembrete.
  for (const card of scope.accounts.filter((a) => a.kind === 'credit_card')) {
    const statement = await cardStatement(deps.db, scope, card, clock.date);
    for (const invoice of statement?.invoices ?? []) {
      if (invoice.remainingCents === 0 || !targets.has(invoice.dueDate)) continue;
      if (invoice.status === 'current' || invoice.status === 'future') continue;
      const when = invoice.dueDate === clock.date ? 'hoje' : formatShortDate(invoice.dueDate);
      lines.push(`• Fatura ${card.name}: ${formatBRL(invoice.remainingCents)} (${when})`);
    }
  }
  if (lines.length === 0) return [];
  return [
    enqueue(
      deps,
      scope,
      `bills:${scope.household.id}:${clock.date}`,
      ['📅 Contas chegando:', ...lines, 'Pagou? É só me avisar.'].join('\n'),
    ),
  ];
}

async function budgetSweep(deps: Deps, scope: Scope, clock: LocalClock): Promise<Stmt[]> {
  const period = periodOf(clock.date);
  const views = await loadBudgetViews(deps.db, scope, period);
  const statements: Stmt[] = [];
  const lines: string[] = [];
  for (const view of views) {
    const fresh = newThresholds(
      view.status.limitCents,
      view.status.spentCents,
      scope.settings.budgetAlertThresholds,
      view.alerted,
    );
    if (fresh.length === 0) continue;
    statements.push(...alertStatementsFor(deps, view, period, fresh));
    lines.push(
      `• ${view.categoryName}: ${thresholdLabel(fresh.at(-1)!)} (${formatBRL(view.status.spentCents)} de ${formatBRL(view.status.limitCents)})`,
    );
  }
  if (lines.length > 0) {
    statements.push(
      enqueue(
        deps,
        scope,
        `budget-sweep:${scope.household.id}:${clock.date}`,
        ['⚠️ Orçamento:', ...lines].join('\n'),
      ),
    );
  }
  return statements;
}

async function weeklySummary(deps: Deps, scope: Scope, clock: LocalClock): Promise<Stmt[]> {
  const previousWeek = weekRange(addDays(clock.date, -7));
  const flow = await cashFlow(deps.db, scope.household.id, previousWeek);
  if (flow.expenseCents === 0 && flow.incomeCents === 0) return [];
  const text = await weekReport(deps, scope, previousWeek.from);
  const observations = await periodObservations(
    deps,
    scope,
    previousWeek,
    weekRange(addDays(previousWeek.from, -7)),
  );
  return [
    enqueue(
      deps,
      scope,
      `weekly:${scope.household.id}:${previousWeek.from}`,
      [`🗓️ ${text}`, ...observations].join('\n'),
    ),
  ];
}

async function monthlyClosing(deps: Deps, scope: Scope, clock: LocalClock): Promise<Stmt[]> {
  const previous = addMonths(periodOf(clock.date), -1);
  const range = monthRange(previous);
  const flow = await cashFlow(deps.db, scope.household.id, range);
  if (flow.expenseCents === 0 && flow.incomeCents === 0) return [];
  const text = await monthReport(deps, scope, previous);
  const observations = await periodObservations(
    deps,
    scope,
    range,
    monthRange(addMonths(previous, -1)),
  );
  const goal = (await loadGoals(deps.db, scope.household.id, range.to)).find(
    (g) => g.kind === 'apartment',
  );
  const planned = goal?.progress.plannedMonthlyCents;
  if (goal && planned) {
    const saved = goal.progress.confirmedThisMonthCents;
    observations.push(
      saved > 0
        ? `Apartamento: guardaram ${formatBRL(saved)} de ${formatBRL(planned)} pretendidos.`
        : `Apartamento: nenhum aporte registrado no mês (pretendido ${formatBRL(planned)}). Se guardaram, registrem com /aporte.`,
    );
  }
  return [
    enqueue(
      deps,
      scope,
      `monthly:${scope.household.id}:${previous}`,
      [`📘 Fechamento de ${monthName(previous)}`, text, ...observations].join('\n'),
    ),
  ];
}

async function goalFollowUp(deps: Deps, scope: Scope, clock: LocalClock): Promise<Stmt[]> {
  const goals = await loadGoals(deps.db, scope.household.id, clock.date);
  if (!goals.some((g) => g.progress.targetCents !== null)) return [];
  const text = await goalReport(deps, scope, clock.date);
  return [enqueue(deps, scope, `goal:${scope.household.id}:${periodOf(clock.date)}`, text)];
}

const GOAL_GAP_FROM_DAY = 20;

/** Perto do fim do mes, compara o que foi guardado com o que se pretendia guardar. */
async function goalGapAlert(deps: Deps, scope: Scope, clock: LocalClock): Promise<Stmt[]> {
  const goals = (await loadGoals(deps.db, scope.household.id, clock.date)).filter(
    (g) => (g.progress.plannedMonthlyCents ?? 0) > 0 && (g.progress.remainingCents ?? 1) > 0,
  );
  if (goals.length === 0) return [];
  const lines = goals.map((goal) => {
    const planned = goal.progress.plannedMonthlyCents!;
    const saved = goal.progress.confirmedThisMonthCents;
    return saved >= planned
      ? `• ${goal.name}: ${formatBRL(saved)} guardados, meta do mês batida. 👏`
      : `• ${goal.name}: ${formatBRL(saved)} de ${formatBRL(planned)} neste mês; faltam ${formatBRL(planned - saved)}.`;
  });
  return [
    enqueue(
      deps,
      scope,
      `goal-gap:${scope.household.id}:${periodOf(clock.date)}`,
      ['🎯 Como estão as metas do mês:', ...lines, 'Guardou e não anotou? Use /aporte.'].join('\n'),
    ),
  ];
}

const RECONCILIATION_WINDOW_MS = 30 * DAY_MS;

async function reconciliationReminder(
  deps: Deps,
  scope: Scope,
  clock: LocalClock,
): Promise<Stmt[]> {
  const rows = await deps.db
    .select({ accountId: balanceReconciliations.accountId })
    .from(balanceReconciliations)
    .where(
      and(
        eq(balanceReconciliations.householdId, scope.household.id),
        eq(balanceReconciliations.status, 'pending'),
        gt(balanceReconciliations.createdAt, deps.now() - RECONCILIATION_WINDOW_MS),
      ),
    );
  const names = [...new Set(rows.map((r) => r.accountId))]
    .map((id) => scope.accounts.find((a) => a.id === id)?.name)
    .filter(Boolean);
  if (names.length === 0) return [];
  return [
    enqueue(
      deps,
      scope,
      `reconcile:${scope.household.id}:${weekRange(clock.date).from}`,
      `🔎 Saldo divergente sem decisão: ${names.join(', ')}. Confira com /saldo CONTA VALOR.`,
    ),
  ];
}

const TREND_MIN_MONTHS = 3;
const TREND_MIN_DAY = 8;
const TREND_MIN_DELTA_CENTS = 5_000;
const EXCEPTIONAL_MIN_CENTS = 20_000;
const EXCEPTIONAL_MIN_HISTORY = 5;
const MAX_INSIGHT_LINES = 3;

/**
 * Observacoes semanais com numeros calculados aqui, sem IA. Tendencia so com historico de
 * pelo menos tres meses, para nao tirar conclusao de pouco dado.
 */
async function spendingInsights(deps: Deps, scope: Scope, clock: LocalClock): Promise<Stmt[]> {
  const period = periodOf(clock.date);
  const months = [1, 2, 3].map((n) => addMonths(period, -n));
  const rows = await deps.db
    .select({
      categoryId: financialTransactions.categoryId,
      date: financialTransactions.financialDate,
      amountCents: financialTransactions.amountCents,
      description: financialTransactions.description,
    })
    .from(financialTransactions)
    .where(
      and(
        eq(financialTransactions.householdId, scope.household.id),
        eq(financialTransactions.status, 'confirmed'),
        eq(financialTransactions.type, 'expense'),
        gte(financialTransactions.financialDate, monthRange(months[2]!).from),
        lte(financialTransactions.financialDate, clock.date),
      ),
    );
  const withData = new Set(rows.map((r) => periodOf(r.date)));
  if (months.some((m) => !withData.has(m)) || months.length < TREND_MIN_MONTHS) return [];

  const categoryName = (id: string | null) =>
    scope.categories.find((c) => c.id === id)?.name ?? 'Sem categoria';
  const day = Number(clock.date.slice(8));
  const daysInMonth = Number(monthRange(period).to.slice(8));
  const up: string[] = [];
  const down: string[] = [];
  if (day >= TREND_MIN_DAY) {
    for (const categoryId of new Set(rows.map((r) => r.categoryId))) {
      const inCategory = rows.filter((r) => r.categoryId === categoryId);
      const history = inCategory
        .filter((r) => periodOf(r.date) !== period)
        .reduce((sum, r) => sum + r.amountCents, 0);
      const current = inCategory
        .filter((r) => periodOf(r.date) === period)
        .reduce((sum, r) => sum + r.amountCents, 0);
      const usual = Math.round(((history / months.length) * day) / daysInMonth);
      if (current >= Math.round(usual * 1.3) && current - usual >= TREND_MIN_DELTA_CENTS) {
        up.push(
          `• ${categoryName(categoryId)}: ${formatBRL(current)} até agora; o ritmo usual seria ${formatBRL(usual)}.`,
        );
      } else if (
        usual > 0 &&
        current <= Math.round(usual * 0.7) &&
        usual - current >= TREND_MIN_DELTA_CENTS
      ) {
        down.push(
          `• ${categoryName(categoryId)}: ${formatBRL(current)} até agora, abaixo dos ${formatBRL(usual)} de costume. Boa! 👏`,
        );
      }
    }
  }

  const lastWeek = weekRange(addDays(clock.date, -7));
  const exceptional: string[] = [];
  for (const row of rows) {
    if (row.date < lastWeek.from || row.date > lastWeek.to) continue;
    if (row.amountCents < EXCEPTIONAL_MIN_CENTS) continue;
    const others = rows.filter((r) => r.categoryId === row.categoryId && r !== row);
    if (others.length < EXCEPTIONAL_MIN_HISTORY) continue;
    const average = others.reduce((sum, r) => sum + r.amountCents, 0) / others.length;
    if (row.amountCents >= average * 3) {
      exceptional.push(
        `• ${row.description}: ${formatBRL(row.amountCents)}, bem acima da média de ${formatBRL(Math.round(average))} em ${categoryName(row.categoryId)}.`,
      );
    }
  }

  const blocks = [
    up.length ? ['Acima do costume neste mês:', ...up.slice(0, MAX_INSIGHT_LINES)] : [],
    exceptional.length
      ? ['Fora do padrão na semana passada:', ...exceptional.slice(0, MAX_INSIGHT_LINES)]
      : [],
    down.length ? ['Abaixo do costume:', ...down.slice(0, MAX_INSIGHT_LINES)] : [],
  ].flat();
  if (blocks.length === 0) return [];
  return [
    enqueue(
      deps,
      scope,
      `insights:${scope.household.id}:${weekRange(clock.date).from}`,
      ['💡 Para olhar com calma:', ...blocks, 'São comparações com os últimos 3 meses.'].join('\n'),
    ),
  ];
}

/** Decide o que enviar com base no relogio local. As chaves de dedup impedem repeticao. */
export async function proactiveStatements(
  deps: Deps,
  scope: Scope,
  instant: number,
): Promise<Stmt[]> {
  const { notifications } = scope.settings;
  if (!notifications.enabled) return [];
  const clock = localClock(instant, scope.household.timezone);
  const statements: Stmt[] = [];
  const dayOfMonth = Number(clock.date.slice(8));
  if (clock.hour >= DAILY_HOUR && clock.hour < 21) {
    if (notifications.billReminders) statements.push(...(await billReminders(deps, scope, clock)));
    if (notifications.budgetAlerts) statements.push(...(await budgetSweep(deps, scope, clock)));
    if (dayOfMonth === 1 && notifications.monthlyClosing) {
      statements.push(...(await monthlyClosing(deps, scope, clock)));
    }
    if (dayOfMonth === 15 && notifications.goalFollowUp) {
      statements.push(...(await goalFollowUp(deps, scope, clock)));
    }
    if (dayOfMonth >= GOAL_GAP_FROM_DAY && notifications.goalFollowUp) {
      statements.push(...(await goalGapAlert(deps, scope, clock)));
    }
  }
  if (
    clock.weekday === 1 &&
    clock.hour >= WEEKLY_HOUR &&
    clock.hour < 21 &&
    notifications.weeklySummary
  ) {
    statements.push(...(await weeklySummary(deps, scope, clock)));
  }
  if (clock.weekday === 1 && clock.hour >= WEEKLY_HOUR && clock.hour < 21) {
    statements.push(...(await reconciliationReminder(deps, scope, clock)));
    if (notifications.behavioralTips) {
      statements.push(...(await spendingInsights(deps, scope, clock)));
    }
  }
  return statements;
}

async function purgeExpired(deps: Deps): Promise<void> {
  const now = deps.now();
  await commitAtomically(deps.db, [
    deps.db
      .update(pendingActions)
      .set({ status: 'expired', resolvedAt: now })
      .where(and(eq(pendingActions.status, 'pending'), lt(pendingActions.expiresAt, now))),
    deps.db
      .delete(incomingEvents)
      .where(
        and(
          inArray(incomingEvents.status, ['processed', 'ignored', 'failed']),
          lt(incomingEvents.receivedAt, now - RETENTION_MS),
        ),
      ),
    deps.db
      .delete(outgoingMessages)
      .where(
        and(
          or(eq(outgoingMessages.status, 'sent'), eq(outgoingMessages.status, 'failed')),
          lt(outgoingMessages.createdAt, now - RETENTION_MS),
        ),
      ),
  ]);
}

export async function runHourly(deps: Deps, instant: number): Promise<void> {
  const rows = await deps.db.select({ id: households.id }).from(households);
  for (const { id } of rows) {
    const scope = await loadScope(deps.db, id);
    if (!scope) continue;
    try {
      await commitAtomically(deps.db, await proactiveStatements(deps, scope, instant));
    } catch (error) {
      logEvent('error', 'proactive_failed', { code: errorCode(error) });
    }
  }
  if (hasBudget(deps.meter)) await purgeExpired(deps);
  await deliverDueMessages(deps, DELIVERIES_PER_RUN);
}
