import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { newThresholds } from '../../domain/budgets/budget';
import { findRecurringMatch } from '../../domain/finance/recurring';
import type {
  ResolvedTransaction,
  Slot,
  TransactionDraft,
} from '../../domain/finance/transactions';
import {
  defaultCreditCard,
  isBareCardHint,
  matchAccount,
  resolveDraft,
} from '../../domain/finance/transactions';
import { cycleForInstallment } from '../../domain/finance/card-cycle';
import { cardDays } from '../queries/cards';
import type { Stmt } from '../../infrastructure/database/client';
import {
  budgetAlerts,
  financialTransactions,
  installmentPlans,
  installments,
  pendingActions,
  recurringEntries,
  recurringSettlements,
} from '../../infrastructure/database/schema';
import { formatShortDate, monthRange, periodOf, resolveDateExpression } from '../../shared/dates';
import { formatBRL, splitInstallments } from '../../shared/money';
import type { Actor, Deps, Effect, Reply } from '../context';
import { ledgerContext, replyOnly } from '../context';
import type { BudgetView, ExtraExpense } from '../queries/finance';
import { accountBalances, loadBudgetViews, shortId } from '../queries/finance';
import { cardStatement } from '../queries/cards';
import { reservedShortfall } from './goals';
import type { Account } from '../context';
import { prepareIncomeDrafts } from './income';
import {
  budgetNudge,
  incomeOpener,
  registeredOpener,
  thresholdLabel,
  transferOpener,
} from '../services/tone';
import { auditStatement } from './shared';

import type { GoalMovement } from './goals';

export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
/** Lancamento igual da outra pessoa nessa janela sugere que os dois registraram a mesma compra. */
const DUPLICATE_WINDOW_MS = 12 * 60 * 60 * 1000;
/** Da mesma pessoa, so um reenvio quase imediato e suspeito (dois cafes iguais sao normais). */
const SELF_DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
const MAX_INSTALLMENTS = 48;

export interface RecordOptions {
  origin: 'command' | 'natural_language' | 'confirmation';
  idempotencyPrefix: string;
  /** Quando presente, nada e gravado antes da confirmacao explicita do usuario. */
  confirmationReason?: string | null;
  /** Gravacoes extras que precisam entrar na mesma transacao (ex.: resolver a pendencia). */
  extraStatements?: Stmt[];
}

export type PendingPayload =
  | {
      type: 'fill_slot';
      drafts: TransactionDraft[];
      index: number;
      slot: Slot;
      candidateCents?: number;
      origin: RecordOptions['origin'];
      confirmationReason?: string;
    }
  | { type: 'confirm_transactions'; drafts: TransactionDraft[] }
  | { type: 'void_transaction'; transactionId: string }
  | {
      type: 'correct_transaction';
      transactionId: string;
      field: 'amount' | 'category' | 'date';
      value: string;
    }
  | { type: 'void_contribution'; contributionId: string }
  | { type: 'archive_account'; accountId: string }
  | { type: 'archive_goal'; goalId: string }
  | { type: 'reconcile'; reconciliationId: string }
  | { type: 'goal_location'; movement: GoalMovement; linkedAccountId?: string | null }
  | { type: 'goal_move'; movement: GoalMovement }
  | { type: 'onboarding'; step: string }
  | { type: 'onboarding_confirm' };

/** Fixa datas relativas agora: "ontem" nao pode mudar se a confirmacao vier no dia seguinte. */
function freezeDrafts(drafts: TransactionDraft[], today: string): TransactionDraft[] {
  return drafts.map((draft) => {
    if (draft.resolvedDate) return draft;
    const resolution = resolveDateExpression(draft.dateText ?? '', today);
    return resolution.status === 'ok' ? { ...draft, resolvedDate: resolution.date } : draft;
  });
}

export function createPendingStatement(
  deps: Deps,
  actor: Actor,
  id: string,
  payload: PendingPayload,
): Stmt {
  return deps.db.insert(pendingActions).values({
    id,
    householdId: actor.scope.household.id,
    memberId: actor.member.id,
    kind: payload.type,
    payload: JSON.stringify(payload),
    status: 'pending',
    expiresAt: deps.now() + PENDING_TTL_MS,
    createdAt: deps.now(),
  });
}

export function confirmationButtons(pendingId: string): NonNullable<Reply['buttons']> {
  return [
    [
      { text: '✅ Confirmar', data: `pa:c:${pendingId}` },
      { text: '❌ Cancelar', data: `pa:x:${pendingId}` },
    ],
  ];
}

function describeDraft(draft: TransactionDraft): string {
  const value =
    draft.amountCents !== undefined ? formatBRL(draft.amountCents) : (draft.amountText ?? '?');
  return `${value} — ${draft.description}`;
}

export function statementsForTransaction(
  deps: Deps,
  actor: Actor,
  transaction: ResolvedTransaction,
  id: string,
  idempotencyKey: string,
  origin: RecordOptions['origin'],
): Stmt[] {
  const now = deps.now();
  const householdId = actor.scope.household.id;
  const statements: Stmt[] = [
    deps.db.insert(financialTransactions).values({
      id,
      householdId,
      type: transaction.type,
      transferKind: transaction.transferKind,
      amountCents: transaction.amountCents,
      description: transaction.description,
      categoryId: transaction.categoryId,
      sourceAccountId: transaction.sourceAccountId,
      destinationAccountId: transaction.destinationAccountId,
      memberId: transaction.memberId,
      isShared: transaction.isShared,
      createdByMemberId: actor.member.id,
      financialDate: transaction.financialDate,
      origin,
      sourceChatId: actor.chatId,
      sourceMessageId: actor.messageId,
      idempotencyKey,
      createdAt: now,
      updatedAt: now,
    }),
    auditStatement(deps, actor, 'transaction.created', 'transaction', id, {
      after: {
        type: transaction.type,
        amountCents: transaction.amountCents,
        categoryId: transaction.categoryId,
        financialDate: transaction.financialDate,
      },
    }),
  ];

  if (transaction.installments !== null) {
    const planId = deps.newId();
    // Com fechamento e vencimento cadastrados, o cronograma e calculado; sem eles, fica vazio.
    const days = installmentCardDays(actor, transaction);
    const dueOf = (sequence: number) =>
      days ? cycleForInstallment(transaction.financialDate, sequence, days).dueDate : null;
    statements.push(
      deps.db.insert(installmentPlans).values({
        id: planId,
        householdId,
        transactionId: id,
        totalCents: transaction.amountCents,
        installmentCount: transaction.installments,
        firstDueDate: dueOf(1),
        createdAt: now,
      }),
    );
    splitInstallments(transaction.amountCents, transaction.installments).forEach((amount, i) => {
      statements.push(
        deps.db.insert(installments).values({
          id: deps.newId(),
          planId,
          sequence: i + 1,
          amountCents: amount,
          dueDate: dueOf(i + 1),
        }),
      );
    });
  }
  return statements;
}

function installmentCardDays(actor: Actor, transaction: ResolvedTransaction) {
  const card = actor.scope.accounts.find((a) => a.id === transaction.sourceAccountId);
  return card ? cardDays(card) : null;
}

function transactionLine(actor: Actor, transaction: ResolvedTransaction, id: string): string {
  const amount = formatBRL(transaction.amountCents);
  const code = `#${shortId(id)}`;
  const whenText =
    transaction.financialDate === actor.today
      ? ''
      : ` em ${formatShortDate(transaction.financialDate)}`;
  const who = transaction.memberId === actor.member.id ? '' : ` (${transaction.memberName})`;

  if (transaction.type === 'transfer') {
    const label =
      transaction.transferKind === 'card_payment' ? 'Pagamento de fatura' : 'Transferência';
    return `${label}: ${amount}, ${transaction.sourceAccountName} → ${transaction.destinationAccountName}${whenText}. Não conta como despesa nem receita. ${code}`;
  }
  if (transaction.type === 'income') {
    const account = transaction.destinationAccountName
      ? ` em ${transaction.destinationAccountName}`
      : '';
    return `${amount} de entrada em ${transaction.categoryName}${who}${account}${whenText}. ${code}`;
  }
  const account = transaction.sourceAccountName ? ` · ${transaction.sourceAccountName}` : '';
  let line = `${amount} em ${transaction.categoryName}${who}${account}${whenText}. ${code}`;
  if (transaction.installments !== null) {
    const parts = splitInstallments(transaction.amountCents, transaction.installments);
    const days = installmentCardDays(actor, transaction);
    const schedule = days
      ? `1ª parcela na fatura que vence ${formatShortDate(cycleForInstallment(transaction.financialDate, 1, days).dueDate)}.`
      : `Sem data de 1º vencimento ainda: cadastre os dias do cartão (/editconta ${transaction.sourceAccountName} fecha=3 vence=10) ou informe com /parcela_data ${shortId(id)} 10/12.`;
    line += `\n${transaction.installments}x de ${formatBRL(parts[parts.length - 1]!)}${parts[0] !== parts[parts.length - 1] ? ` (1ª de ${formatBRL(parts[0]!)})` : ''}. ${schedule}`;
  }
  return line;
}

/** Soma dos lancamentos confirmados do mes que correspondem a recorrencia. */
export async function matchedAmountInPeriod(
  deps: Deps,
  actor: Actor,
  entry: typeof recurringEntries.$inferSelect,
  period: string,
): Promise<number> {
  const range = monthRange(period);
  const rows = await deps.db
    .select({
      description: financialTransactions.description,
      memberId: financialTransactions.memberId,
      amountCents: financialTransactions.amountCents,
    })
    .from(financialTransactions)
    .where(
      and(
        eq(financialTransactions.householdId, actor.scope.household.id),
        eq(financialTransactions.status, 'confirmed'),
        eq(financialTransactions.type, entry.kind),
        gte(financialTransactions.financialDate, range.from),
        lte(financialTransactions.financialDate, range.to),
      ),
    );
  return rows
    .filter((row) => findRecurringMatch(row.description, entry.kind, row.memberId, [entry]))
    .reduce((sum, row) => sum + row.amountCents, 0);
}

/** Lancamento igual feito ha pouco: os dois registraram a mesma compra, ou reenvio acidental. */
async function findRecentTwin(
  deps: Deps,
  actor: Actor,
  transaction: ResolvedTransaction,
): Promise<{ memberId: string; createdAt: number } | null> {
  const rows = await deps.db
    .select({
      memberId: financialTransactions.createdByMemberId,
      createdAt: financialTransactions.createdAt,
    })
    .from(financialTransactions)
    .where(
      and(
        eq(financialTransactions.householdId, actor.scope.household.id),
        eq(financialTransactions.status, 'confirmed'),
        eq(financialTransactions.type, transaction.type),
        eq(financialTransactions.amountCents, transaction.amountCents),
        eq(financialTransactions.financialDate, transaction.financialDate),
        gte(financialTransactions.createdAt, deps.now() - DUPLICATE_WINDOW_MS),
      ),
    );
  return (
    rows.find(
      (row) =>
        row.memberId !== actor.member.id || row.createdAt >= deps.now() - SELF_DUPLICATE_WINDOW_MS,
    ) ?? null
  );
}

async function settlementStatements(
  deps: Deps,
  actor: Actor,
  items: readonly { id: string; transaction: ResolvedTransaction }[],
): Promise<{ statements: Stmt[]; notes: string[] }> {
  const candidates = items.filter((item) => item.transaction.type !== 'transfer');
  if (candidates.length === 0) return { statements: [], notes: [] };

  const entries = await deps.db
    .select()
    .from(recurringEntries)
    .where(
      and(
        eq(recurringEntries.householdId, actor.scope.household.id),
        eq(recurringEntries.active, true),
      ),
    );
  if (entries.length === 0) return { statements: [], notes: [] };

  const settled = await deps.db
    .select({ entryId: recurringSettlements.entryId, period: recurringSettlements.period })
    .from(recurringSettlements)
    .where(
      and(
        inArray(
          recurringSettlements.entryId,
          entries.map((entry) => entry.id),
        ),
        inArray(
          recurringSettlements.period,
          candidates.map((item) => periodOf(item.transaction.financialDate)),
        ),
      ),
    );

  const statements: Stmt[] = [];
  const notes: string[] = [];
  const taken = new Set(settled.map((row) => `${row.entryId}:${row.period}`));
  /** Valores ja vinculados nesta mesma mensagem, por recorrencia e mes. */
  const inMessage = new Map<string, number>();
  for (const { id, transaction } of candidates) {
    const period = periodOf(transaction.financialDate);
    const open = entries.filter((entry) => !taken.has(`${entry.id}:${period}`));
    const match = findRecurringMatch(
      transaction.description,
      transaction.type as 'expense' | 'income',
      transaction.memberId,
      open,
    );
    if (!match) continue;
    const key = `${match.id}:${period}`;
    if (match.amountCents !== null) {
      // Pagamento ou recebimento parcial nao quita a previsao do mes.
      const earlier = await matchedAmountInPeriod(deps, actor, match, period);
      const total = earlier + (inMessage.get(key) ?? 0) + transaction.amountCents;
      inMessage.set(key, (inMessage.get(key) ?? 0) + transaction.amountCents);
      if (total < match.amountCents) {
        notes.push(
          `${match.kind === 'income' ? 'Recebido' : 'Pago'} até agora de "${match.description}" neste mês: ${formatBRL(total)} de ${formatBRL(match.amountCents)} previstos. Ainda não marquei como ${match.kind === 'income' ? 'recebido' : 'pago'}.`,
        );
        continue;
      }
    }
    taken.add(key);
    statements.push(
      deps.db.insert(recurringSettlements).values({
        id: deps.newId(),
        entryId: match.id,
        period,
        transactionId: id,
        createdAt: deps.now(),
      }),
    );
    notes.push(
      `Marquei "${match.description}" de ${formatShortDate(`${period}-01`).slice(3)} como ${match.kind === 'income' ? 'recebido' : 'pago'}.`,
    );
  }
  return { statements, notes };
}

export function alertStatementsFor(
  deps: Deps,
  view: BudgetView,
  period: string,
  thresholds: readonly number[],
): Stmt[] {
  return thresholds.map((threshold) =>
    deps.db
      .insert(budgetAlerts)
      .values({
        id: deps.newId(),
        budgetId: view.id,
        period,
        threshold,
        spentCents: view.status.spentCents,
        createdAt: deps.now(),
      })
      .onConflictDoNothing(),
  );
}

async function budgetFollowUp(
  deps: Deps,
  actor: Actor,
  items: readonly { transaction: ResolvedTransaction }[],
  seed: string,
): Promise<{ statements: Stmt[]; notes: string[] }> {
  const expenses = items.filter((item) => item.transaction.type === 'expense');
  if (expenses.length === 0) return { statements: [], notes: [] };

  const statements: Stmt[] = [];
  const notes: string[] = [];
  const { settings } = actor.scope;
  const periods = [...new Set(expenses.map((i) => periodOf(i.transaction.financialDate)))];

  for (const period of periods) {
    const extras: ExtraExpense[] = expenses
      .filter((i) => periodOf(i.transaction.financialDate) === period)
      .map((i) => ({
        categoryId: i.transaction.categoryId,
        memberId: i.transaction.memberId,
        isShared: i.transaction.isShared,
        amountCents: i.transaction.amountCents,
      }));
    const views = await loadBudgetViews(deps.db, actor.scope, period, extras);
    for (const view of views) {
      const affected = extras.some(
        (extra) =>
          (view.categoryId === null || view.categoryId === extra.categoryId) &&
          (view.memberId === null || (view.memberId === extra.memberId && !extra.isShared)),
      );
      if (!affected) continue;
      const fresh = newThresholds(
        view.status.limitCents,
        view.status.spentCents,
        settings.budgetAlertThresholds,
        view.alerted,
      );
      statements.push(...alertStatementsFor(deps, view, period, fresh));
      if (fresh.length > 0 || view.categoryId !== null) {
        const nudge = budgetNudge(view, settings.tone, seed);
        if (nudge) notes.push(nudge);
        else if (fresh.length > 0)
          notes.push(`Alerta de orçamento: ${thresholdLabel(fresh.at(-1)!)}.`);
      }
    }
  }
  return { statements, notes };
}

/**
 * Caminho unico de registro. Aplica as regras financeiras e devolve as gravacoes;
 * o chamador as confirma junto com a resposta, em uma so transacao do D1.
 */
/** O cartao que um pagamento sem valor quer quitar, quando nao ha duvida. */
function paymentCard(actor: Actor, draft: TransactionDraft): Account | null {
  const context = ledgerContext(actor);
  const cards = actor.scope.accounts.filter((a) => a.kind === 'credit_card');
  const direct = cards.find((c) => c.id === draft.destinationAccountId);
  if (direct) return direct;
  const member = context.members.find((m) => m.id === actor.member.id);
  const hint = isBareCardHint(draft.destinationAccountText) ? null : draft.destinationAccountText;
  const match = matchAccount(hint, context.accounts, { memberId: actor.member.id, only: 'card' });
  const id =
    match.status === 'found'
      ? match.account.id
      : match.status === 'no_hint' && member
        ? (() => {
            const fallback = defaultCreditCard(member, context.accounts);
            return fallback.status === 'found' ? fallback.account.id : null;
          })()
        : null;
  return cards.find((c) => c.id === id) ?? null;
}

/** "A fatura foi paga": mostra o valor em aberto e so registra depois da resposta. */
async function askInvoiceAmount(
  deps: Deps,
  actor: Actor,
  drafts: TransactionDraft[],
  options: RecordOptions,
): Promise<Effect | null> {
  const index = drafts.findIndex(
    (d) => d.kind === 'card_payment' && d.amountText === null && d.amountCents === undefined,
  );
  if (index < 0 || options.origin === 'confirmation') return null;
  const card = paymentCard(actor, drafts[index]!);
  if (!card) return null;
  const statement = await cardStatement(deps.db, actor.scope, card, actor.today);
  if (!statement) return null;
  const open = statement.invoices.filter((i) => i.status !== 'future' && i.remainingCents > 0);
  const total = open.reduce((sum, i) => sum + i.remainingCents, 0);
  if (total === 0) {
    return replyOnly(`${card.name} não tem fatura em aberto. Veja /faturas ${card.name}.`);
  }
  const pendingId = deps.newId();
  return {
    statements: [
      ...(options.extraStatements ?? []),
      createPendingStatement(deps, actor, pendingId, {
        type: 'fill_slot',
        drafts: freezeDrafts(drafts, actor.today),
        index,
        slot: 'amount',
        origin: options.origin,
        candidateCents: total,
      }),
    ],
    replies: [
      {
        text: `${card.name}: ${formatBRL(total)} em aberto, vencimento em ${formatShortDate(open[0]!.dueDate)}. Foi o total? Responda "sim" ou o valor pago.`,
      },
    ],
  };
}

/** Situacao da fatura depois do pagamento, para o usuario saber se quitou. */
async function paymentNotes(
  deps: Deps,
  actor: Actor,
  items: readonly { transaction: ResolvedTransaction }[],
): Promise<string[]> {
  const notes: string[] = [];
  for (const { transaction } of items) {
    if (transaction.transferKind !== 'card_payment') continue;
    const card = actor.scope.accounts.find((a) => a.id === transaction.destinationAccountId);
    if (!card) continue;
    const statement = await cardStatement(deps.db, actor.scope, card, actor.today);
    if (!statement) continue;
    const open = statement.invoices
      .filter((i) => i.status !== 'future')
      .reduce((sum, i) => sum + i.remainingCents, 0);
    const left = open - transaction.amountCents;
    if (open === 0)
      notes.push(`${card.name} não tinha fatura em aberto: o valor fica como crédito.`);
    else if (left > 0)
      notes.push(`Pagamento parcial: ainda faltam ${formatBRL(left)} em ${card.name}.`);
    else notes.push(`Fatura de ${card.name} quitada ✅`);
  }
  return notes;
}

export async function recordDrafts(
  deps: Deps,
  actor: Actor,
  received: TransactionDraft[],
  options: RecordOptions,
): Promise<Effect> {
  const context = ledgerContext(actor);
  const resolved: ResolvedTransaction[] = [];
  const reservedNotes: string[] = [];

  const income =
    options.origin !== 'confirmation' && received.some((d) => d.kind === 'income')
      ? await prepareIncomeDrafts(deps, actor, received)
      : null;
  if (income?.stop) return income.stop;
  const drafts = income?.drafts ?? received;
  const invoiceQuestion = await askInvoiceAmount(deps, actor, drafts, options);
  if (invoiceQuestion) return invoiceQuestion;

  for (let index = 0; index < drafts.length; index++) {
    const outcome = resolveDraft(drafts[index]!, context);
    if (outcome.status === 'rejected') {
      return replyOnly(`Não registrei nada. ${outcome.reason}`);
    }
    if (outcome.status === 'needs_input') {
      const pendingId = deps.newId();
      const payload: PendingPayload = {
        type: 'fill_slot',
        drafts: freezeDrafts(drafts, actor.today),
        index,
        slot: outcome.slot,
        origin: options.origin,
        ...(outcome.candidateCents !== undefined && { candidateCents: outcome.candidateCents }),
        ...(options.confirmationReason && { confirmationReason: options.confirmationReason }),
      };
      return {
        statements: [
          ...(options.extraStatements ?? []),
          createPendingStatement(deps, actor, pendingId, payload),
        ],
        replies: [{ text: outcome.question }],
      };
    }
    if (
      outcome.transaction.installments !== null &&
      outcome.transaction.installments > MAX_INSTALLMENTS
    ) {
      return replyOnly(`Não registrei nada. O limite é de ${MAX_INSTALLMENTS} parcelas.`);
    }
    resolved.push(outcome.transaction);
  }

  let confirmationReason = options.confirmationReason ?? income?.reason ?? null;
  const spendingAccounts = resolved.filter(
    (t) => t.sourceAccountId !== null && !t.isCreditPurchase,
  );
  if (spendingAccounts.length > 0) {
    const positions = await accountBalances(deps.db, actor.scope);
    const needed = new Map<string, number>();
    for (const t of spendingAccounts) {
      needed.set(t.sourceAccountId!, (needed.get(t.sourceAccountId!) ?? 0) + t.amountCents);
    }
    for (const [accountId, amount] of needed) {
      const position = positions.find((p) => p.id === accountId);
      const shortfall = position ? reservedShortfall(position, amount) : null;
      if (!position || shortfall === null) continue;
      if (options.origin === 'confirmation') {
        reservedNotes.push(
          `${position.name}: ${formatBRL(shortfall)} reservados para metas ficaram sem saldo. Ajuste com /retirada META VALOR @${position.name}.`,
        );
      } else if (!confirmationReason) {
        const goals = position.allocations.map((a) => a.goalName).join(', ');
        confirmationReason = `Isso usa ${formatBRL(shortfall)} que estão reservados em ${position.name} para ${goals}. Registrar mesmo assim?`;
      }
    }
  }
  if (!confirmationReason && options.origin !== 'confirmation') {
    for (const transaction of resolved) {
      const twin = await findRecentTwin(deps, actor, transaction);
      if (!twin) continue;
      const who =
        twin.memberId === actor.member.id
          ? 'você mesmo'
          : (actor.scope.members.find((m) => m.id === twin.memberId)?.name ?? 'alguém');
      confirmationReason = `Parece repetido: ${who} já registrou ${formatBRL(transaction.amountCents)} nessa data há pouco. Registrar de novo mesmo assim?`;
      break;
    }
  }

  if (confirmationReason) {
    const pendingId = deps.newId();
    const frozen = freezeDrafts(drafts, actor.today);
    return {
      statements: [
        ...(options.extraStatements ?? []),
        createPendingStatement(deps, actor, pendingId, {
          type: 'confirm_transactions',
          drafts: frozen,
        }),
      ],
      replies: [
        {
          text: `${confirmationReason}\n${frozen.map((d) => `• ${describeDraft(d)}`).join('\n')}\nConfirma?`,
          buttons: confirmationButtons(pendingId),
        },
      ],
    };
  }

  const items = resolved.map((transaction, index) => ({
    transaction,
    id: deps.newId(),
    key: `${options.idempotencyPrefix}:${index}`,
  }));
  const statements: Stmt[] = [...(options.extraStatements ?? [])];
  for (const item of items) {
    statements.push(
      ...statementsForTransaction(deps, actor, item.transaction, item.id, item.key, options.origin),
    );
  }

  const settlement = await settlementStatements(deps, actor, items);
  const reserveIds = new Set(
    actor.scope.accounts
      .filter((a) => a.kind === 'reserve' || a.kind === 'savings')
      .map((a) => a.id),
  );
  const toReserve = items.find(
    (i) =>
      i.transaction.transferKind === 'internal' &&
      i.transaction.destinationAccountId !== null &&
      reserveIds.has(i.transaction.destinationAccountId),
  );
  if (toReserve) {
    settlement.notes.push(
      `Se esse dinheiro é para o apartamento, confirme com /aporte ${formatBRL(toReserve.transaction.amountCents).replace('R$ ', '')}: transferência sozinha não conta na meta.`,
    );
  }
  settlement.notes.push(...(await paymentNotes(deps, actor, items)));
  const budget = await budgetFollowUp(deps, actor, items, actor.eventId);
  statements.push(...settlement.statements, ...budget.statements);

  const { tone } = actor.scope.settings;
  const types = new Set(items.map((i) => i.transaction.type));
  const opener =
    types.size === 1 && types.has('income')
      ? incomeOpener(tone, actor.eventId)
      : types.size === 1 && types.has('transfer')
        ? transferOpener(tone)
        : registeredOpener(tone, actor.eventId);
  const lines =
    items.length === 1
      ? [`${opener}: ${transactionLine(actor, items[0]!.transaction, items[0]!.id)}`]
      : [`${opener}:`, ...items.map((i) => `• ${transactionLine(actor, i.transaction, i.id)}`)];
  return {
    statements,
    replies: [
      { text: [...lines, ...settlement.notes, ...budget.notes, ...reservedNotes].join('\n') },
    ],
  };
}
