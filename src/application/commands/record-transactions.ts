import { and, eq, inArray } from 'drizzle-orm';
import { newThresholds } from '../../domain/budgets/budget';
import { findRecurringMatch } from '../../domain/finance/recurring';
import type {
  ResolvedTransaction,
  Slot,
  TransactionDraft,
} from '../../domain/finance/transactions';
import { resolveDraft } from '../../domain/finance/transactions';
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
import { formatShortDate, periodOf, resolveDateExpression } from '../../shared/dates';
import { formatBRL, splitInstallments } from '../../shared/money';
import type { Actor, Deps, Effect, Reply } from '../context';
import { ledgerContext, replyOnly } from '../context';
import type { BudgetView, ExtraExpense } from '../queries/finance';
import { loadBudgetViews, shortId } from '../queries/finance';
import { budgetNudge, registeredOpener, thresholdLabel } from '../services/tone';
import { auditStatement } from './shared';

export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
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
  | { type: 'void_contribution'; contributionId: string };

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

function statementsForTransaction(
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
    statements.push(
      deps.db.insert(installmentPlans).values({
        id: planId,
        householdId,
        transactionId: id,
        totalCents: transaction.amountCents,
        installmentCount: transaction.installments,
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
        }),
      );
    });
  }
  return statements;
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
    line += `\n${transaction.installments}x de ${formatBRL(parts[parts.length - 1]!)}${parts[0] !== parts[parts.length - 1] ? ` (1ª de ${formatBRL(parts[0]!)})` : ''}. Sem data de 1º vencimento ainda: informe com /parcela_data ${shortId(id)} 10/12.`;
  }
  return line;
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
    taken.add(`${match.id}:${period}`);
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
        amountCents: i.transaction.amountCents,
      }));
    const views = await loadBudgetViews(deps.db, actor.scope, period, extras);
    for (const view of views) {
      const affected = extras.some(
        (extra) =>
          (view.categoryId === null || view.categoryId === extra.categoryId) &&
          (view.memberId === null || view.memberId === extra.memberId),
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
export async function recordDrafts(
  deps: Deps,
  actor: Actor,
  drafts: TransactionDraft[],
  options: RecordOptions,
): Promise<Effect> {
  const context = ledgerContext(actor);
  const resolved: ResolvedTransaction[] = [];

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

  if (options.confirmationReason) {
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
          text: `${options.confirmationReason}\n${frozen.map((d) => `• ${describeDraft(d)}`).join('\n')}\nConfirma?`,
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
  const budget = await budgetFollowUp(deps, actor, items, actor.eventId);
  statements.push(...settlement.statements, ...budget.statements);

  const opener = registeredOpener(actor.scope.settings.tone, actor.eventId);
  const lines =
    items.length === 1
      ? [`${opener}: ${transactionLine(actor, items[0]!.transaction, items[0]!.id)}`]
      : [`${opener}:`, ...items.map((i) => `• ${transactionLine(actor, i.transaction, i.id)}`)];
  return {
    statements,
    replies: [{ text: [...lines, ...settlement.notes, ...budget.notes].join('\n') }],
  };
}
