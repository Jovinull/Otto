import { and, eq } from 'drizzle-orm';
import type { Stmt } from '../../infrastructure/database/client';
import {
  financialTransactions as tx,
  goalContributions,
  installmentPlans,
  pendingActions,
  recurringSettlements,
} from '../../infrastructure/database/schema';
import { formatDate, resolveDateExpression } from '../../shared/dates';
import { formatBRL, parseBRL } from '../../shared/money';
import { normalizeText } from '../../shared/text';
import type { Actor, Deps, Effect } from '../context';
import { replyOnly } from '../context';
import { findTransactionByRef, shortId } from '../queries/finance';
import type { PendingPayload } from './record-transactions';
import { confirmationButtons, createPendingStatement } from './record-transactions';
import { auditStatement } from './shared';

type Field = 'amount' | 'category' | 'date';
type Transaction = typeof tx.$inferSelect;

const NOT_FOUND = 'Não encontrei esse lançamento. Veja os códigos em /ultimos.';

/** Guarda de versao evita aplicar uma correcao sobre dados que mudaram depois da leitura. */
function versionGuard(transaction: Transaction, householdId: string) {
  return and(
    eq(tx.id, transaction.id),
    eq(tx.householdId, householdId),
    eq(tx.version, transaction.version),
    eq(tx.status, 'confirmed'),
  );
}

function resolveCategoryValue(actor: Actor, transaction: Transaction, value: string) {
  const text = normalizeText(value).replace(/\s+/g, '-');
  const kind = transaction.type === 'income' ? 'income' : 'expense';
  return actor.scope.categories.find(
    (c) => c.kind === kind && (c.slug === text || normalizeText(c.name) === normalizeText(value)),
  );
}

export function applyCorrection(
  deps: Deps,
  actor: Actor,
  transaction: Transaction,
  field: Field,
  value: string,
  extra: Stmt[] = [],
): Effect {
  const householdId = actor.scope.household.id;
  const now = deps.now();
  const base = { version: transaction.version + 1, updatedAt: now };
  const code = `#${shortId(transaction.id)}`;

  if (field === 'amount') {
    const parsed = parseBRL(value);
    if (parsed.status !== 'ok') return replyOnly('Valor inválido. Exemplo: 1.250,00.');
    return {
      statements: [
        ...extra,
        deps.db
          .update(tx)
          .set({ ...base, amountCents: parsed.cents })
          .where(versionGuard(transaction, householdId)),
        auditStatement(deps, actor, 'transaction.amount_corrected', 'transaction', transaction.id, {
          before: { amountCents: transaction.amountCents },
          after: { amountCents: parsed.cents },
        }),
      ],
      replies: [
        {
          text: `Corrigido ${code}: ${formatBRL(transaction.amountCents)} → ${formatBRL(parsed.cents)}.`,
        },
      ],
    };
  }

  if (field === 'category') {
    if (transaction.type === 'transfer') return replyOnly('Transferências não têm categoria.');
    const category = resolveCategoryValue(actor, transaction, value);
    if (!category) return replyOnly('Categoria não encontrada. Veja /categorias.');
    return {
      statements: [
        ...extra,
        deps.db
          .update(tx)
          .set({ ...base, categoryId: category.id })
          .where(versionGuard(transaction, householdId)),
        auditStatement(
          deps,
          actor,
          'transaction.category_corrected',
          'transaction',
          transaction.id,
          {
            before: { categoryId: transaction.categoryId },
            after: { categoryId: category.id },
          },
        ),
      ],
      replies: [{ text: `Corrigido ${code}: categoria agora é ${category.name}.` }],
    };
  }

  const resolved = resolveDateExpression(value, actor.today);
  if (resolved.status !== 'ok') return replyOnly('Data inválida. Exemplo: 03/11.');
  return {
    statements: [
      ...extra,
      deps.db
        .update(tx)
        .set({ ...base, financialDate: resolved.date })
        .where(versionGuard(transaction, householdId)),
      auditStatement(deps, actor, 'transaction.date_corrected', 'transaction', transaction.id, {
        before: { financialDate: transaction.financialDate },
        after: { financialDate: resolved.date },
      }),
    ],
    replies: [{ text: `Corrigido ${code}: data agora é ${formatDate(resolved.date)}.` }],
  };
}

async function hasInstallmentPlan(deps: Deps, transactionId: string): Promise<boolean> {
  const rows = await deps.db
    .select({ id: installmentPlans.id })
    .from(installmentPlans)
    .where(eq(installmentPlans.transactionId, transactionId))
    .limit(1);
  return rows.length > 0;
}

export async function correctTransaction(
  deps: Deps,
  actor: Actor,
  reference: string | null,
  field: Field,
  value: string,
  requireConfirmation: boolean,
): Promise<Effect> {
  const householdId = actor.scope.household.id;
  const transaction = await findTransactionByRef(deps.db, householdId, reference, actor.member.id);
  if (!transaction) return replyOnly(NOT_FOUND);
  if (field === 'amount' && (await hasInstallmentPlan(deps, transaction.id))) {
    return replyOnly(
      'Compra parcelada não pode ter o valor corrigido: estorne e registre de novo.',
    );
  }

  if (requireConfirmation) {
    const pendingId = deps.newId();
    const payload: PendingPayload = {
      type: 'correct_transaction',
      transactionId: transaction.id,
      field,
      value,
    };
    return {
      statements: [createPendingStatement(deps, actor, pendingId, payload)],
      replies: [
        {
          text: `Corrigir ${transaction.description} (${formatBRL(transaction.amountCents)}, #${shortId(transaction.id)}): ${field === 'amount' ? 'valor' : field === 'category' ? 'categoria' : 'data'} para "${value}"?`,
          buttons: confirmationButtons(pendingId),
        },
      ],
    };
  }
  return applyCorrection(deps, actor, transaction, field, value);
}

export async function requestVoid(
  deps: Deps,
  actor: Actor,
  reference: string | null,
): Promise<Effect> {
  const transaction = await findTransactionByRef(
    deps.db,
    actor.scope.household.id,
    reference,
    actor.member.id,
  );
  if (!transaction) return replyOnly(NOT_FOUND);
  const pendingId = deps.newId();
  return {
    statements: [
      createPendingStatement(deps, actor, pendingId, {
        type: 'void_transaction',
        transactionId: transaction.id,
      }),
    ],
    replies: [
      {
        text: `Estornar ${transaction.description} (${formatBRL(transaction.amountCents)}, ${formatDate(transaction.financialDate)}, #${shortId(transaction.id)})? O histórico fica registrado.`,
        buttons: confirmationButtons(pendingId),
      },
    ],
  };
}

export async function applyVoid(
  deps: Deps,
  actor: Actor,
  transactionId: string,
  extra: Stmt[],
): Promise<Effect> {
  const householdId = actor.scope.household.id;
  const rows = await deps.db
    .select()
    .from(tx)
    .where(
      and(eq(tx.id, transactionId), eq(tx.householdId, householdId), eq(tx.status, 'confirmed')),
    )
    .limit(1);
  const transaction = rows[0];
  if (!transaction) return { statements: extra, replies: [{ text: NOT_FOUND }] };

  const now = deps.now();
  return {
    statements: [
      ...extra,
      deps.db
        .update(tx)
        .set({
          status: 'voided',
          voidedAt: now,
          voidedByMemberId: actor.member.id,
          version: transaction.version + 1,
          updatedAt: now,
        })
        .where(versionGuard(transaction, householdId)),
      // A conta prevista volta a ficar em aberto.
      deps.db
        .delete(recurringSettlements)
        .where(eq(recurringSettlements.transactionId, transaction.id)),
      deps.db
        .update(installmentPlans)
        .set({ status: 'cancelled' })
        .where(eq(installmentPlans.transactionId, transaction.id)),
      // A reserva feita por esta transferencia deixa de existir junto com ela.
      deps.db
        .update(goalContributions)
        .set({ status: 'voided' })
        .where(
          and(
            eq(goalContributions.transactionId, transaction.id),
            eq(goalContributions.status, 'confirmed'),
          ),
        ),
      auditStatement(deps, actor, 'transaction.voided', 'transaction', transaction.id, {
        before: { status: 'confirmed', amountCents: transaction.amountCents },
        after: { status: 'voided' },
      }),
    ],
    replies: [
      {
        text: `Estornado: ${transaction.description} (${formatBRL(transaction.amountCents)}). Não entra mais nos totais.`,
      },
    ],
  };
}

export function resolvePendingStatement(
  deps: Deps,
  pendingId: string,
  status: 'confirmed' | 'cancelled',
): Stmt {
  return deps.db
    .update(pendingActions)
    .set({ status, resolvedAt: deps.now() })
    .where(and(eq(pendingActions.id, pendingId), eq(pendingActions.status, 'pending')));
}

export async function applyContributionVoid(
  deps: Deps,
  actor: Actor,
  contributionId: string,
  extra: Stmt[],
): Promise<Effect> {
  const householdId = actor.scope.household.id;
  const rows = await deps.db
    .select()
    .from(goalContributions)
    .where(
      and(
        eq(goalContributions.id, contributionId),
        eq(goalContributions.householdId, householdId),
        eq(goalContributions.status, 'confirmed'),
      ),
    )
    .limit(1);
  const contribution = rows[0];
  if (!contribution) return { statements: extra, replies: [{ text: 'Aporte não encontrado.' }] };
  const now = deps.now();
  return {
    statements: [
      ...extra,
      deps.db
        .update(goalContributions)
        .set({ status: 'voided' })
        .where(eq(goalContributions.id, contribution.id)),
      // O aporte com transferencia desfaz tambem o movimento entre as contas.
      ...(contribution.transactionId
        ? [
            deps.db
              .update(tx)
              .set({
                status: 'voided',
                voidedAt: now,
                voidedByMemberId: actor.member.id,
                updatedAt: now,
              })
              .where(
                and(
                  eq(tx.id, contribution.transactionId),
                  eq(tx.householdId, householdId),
                  eq(tx.status, 'confirmed'),
                ),
              ),
          ]
        : []),
      auditStatement(
        deps,
        actor,
        'goal_contribution.voided',
        'goal_contribution',
        contribution.id,
        {
          before: { amountCents: contribution.amountCents },
          after: { status: 'voided' },
        },
      ),
    ],
    replies: [
      {
        text: `Aporte de ${formatBRL(contribution.amountCents)} desfeito.${contribution.transactionId ? ' A transferência entre as contas também foi desfeita.' : ''}`,
      },
    ],
  };
}
