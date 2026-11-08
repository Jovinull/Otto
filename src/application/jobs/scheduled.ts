import { and, eq, inArray, lt, or } from 'drizzle-orm';
import { newThresholds } from '../../domain/budgets/budget';
import type { Stmt } from '../../infrastructure/database/client';
import { commitAtomically } from '../../infrastructure/database/client';
import {
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
  periodOf,
  weekRange,
} from '../../shared/dates';
import { errorCode, logEvent } from '../../shared/errors';
import { formatBRL } from '../../shared/money';
import { alertStatementsFor } from '../commands/record-transactions';
import type { Deps, Scope } from '../context';
import { loadScope } from '../context';
import { cashFlow, loadBudgetViews, loadCommitments, loadGoals } from '../queries/finance';
import { goalReport, monthReport, weekReport } from '../queries/reports';
import { findDueEvents, processEvent } from '../services/inbox';
import { thresholdLabel } from '../services/tone';
import { deliverDueMessages } from './outbox';

const DAILY_HOUR = 9;
const WEEKLY_HOUR = 8;
const DAY_MS = 86_400_000;
const RETENTION_MS = 90 * DAY_MS;
/** Cada execucao faz pouco trabalho para caber no limite de CPU do plano gratuito. */
const EVENTS_PER_RUN = 4;
const DELIVERIES_PER_RUN = 10;

export async function runRecovery(deps: Deps): Promise<void> {
  const due = await findDueEvents(deps, EVENTS_PER_RUN);
  for (const eventId of due) {
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
  if (due.length === 0) return [];
  const lines = due.map((item) => {
    const value = item.amountCents === null ? 'valor variável' : formatBRL(item.amountCents);
    const when = item.expected.date === clock.date ? 'hoje' : formatShortDate(item.expected.date!);
    return `• ${item.description}: ${value} (${item.expected.approximate ? 'aprox. ' : ''}${when})`;
  });
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
  return [enqueue(deps, scope, `weekly:${scope.household.id}:${previousWeek.from}`, `🗓️ ${text}`)];
}

async function monthlyClosing(deps: Deps, scope: Scope, clock: LocalClock): Promise<Stmt[]> {
  const previous = addMonths(periodOf(clock.date), -1);
  const text = await monthReport(deps, scope, previous);
  const flow = await cashFlow(deps.db, scope.household.id, {
    from: `${previous}-01`,
    to: `${previous}-31`,
  });
  if (flow.expenseCents === 0 && flow.incomeCents === 0) return [];
  return [
    enqueue(
      deps,
      scope,
      `monthly:${scope.household.id}:${previous}`,
      `📘 Fechamento de ${monthName(previous)}\n${text}`,
    ),
  ];
}

async function goalFollowUp(deps: Deps, scope: Scope, clock: LocalClock): Promise<Stmt[]> {
  const goals = await loadGoals(deps.db, scope.household.id, clock.date);
  if (!goals.some((g) => g.progress.targetCents !== null)) return [];
  const text = await goalReport(deps, scope, clock.date);
  return [enqueue(deps, scope, `goal:${scope.household.id}:${periodOf(clock.date)}`, text)];
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
  }
  if (
    clock.weekday === 1 &&
    clock.hour >= WEEKLY_HOUR &&
    clock.hour < 21 &&
    notifications.weeklySummary
  ) {
    statements.push(...(await weeklySummary(deps, scope, clock)));
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
  await purgeExpired(deps);
  await deliverDueMessages(deps, DELIVERIES_PER_RUN);
}
