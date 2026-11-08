import { and, desc, eq, gt } from 'drizzle-orm';
import { canAdminister, canWrite } from '../../domain/household/authorization';
import { applySlotAnswer, isAffirmative, isNegative } from '../../domain/finance/transactions';
import { financialTransactions, pendingActions } from '../../infrastructure/database/schema';
import {
  applyContributionVoid,
  applyCorrection,
  applyVoid,
  resolvePendingStatement,
} from '../commands/corrections';
import type { PendingPayload } from '../commands/record-transactions';
import { recordDrafts } from '../commands/record-transactions';
import { applyArchiveAccount } from '../commands/editing';
import { applyOnboarding, onboardingAnswer } from './onboarding';
import type { Actor, Deps, Effect } from '../context';
import { ledgerContext, replyOnly } from '../context';

type PendingRow = typeof pendingActions.$inferSelect;

async function latestPending(deps: Deps, actor: Actor): Promise<PendingRow | null> {
  const rows = await deps.db
    .select()
    .from(pendingActions)
    .where(
      and(
        eq(pendingActions.householdId, actor.scope.household.id),
        eq(pendingActions.memberId, actor.member.id),
        eq(pendingActions.status, 'pending'),
        gt(pendingActions.expiresAt, deps.now()),
      ),
    )
    .orderBy(desc(pendingActions.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

function parsePayload(row: PendingRow): PendingPayload {
  return JSON.parse(row.payload) as PendingPayload;
}

async function executeConfirmation(deps: Deps, actor: Actor, row: PendingRow): Promise<Effect> {
  const payload = parsePayload(row);
  const resolution = resolvePendingStatement(deps, row.id, 'confirmed');
  switch (payload.type) {
    case 'confirm_transactions':
    case 'fill_slot':
      return recordDrafts(deps, actor, payload.drafts, {
        origin: 'confirmation',
        idempotencyPrefix: `pending:${row.id}`,
        extraStatements: [resolution],
      });
    case 'void_transaction':
      return applyVoid(deps, actor, payload.transactionId, [resolution]);
    case 'onboarding_confirm':
      return applyOnboarding(deps, actor, [resolution]);
    case 'onboarding':
      return { statements: [resolution], replies: [] };
    case 'archive_account':
      return applyArchiveAccount(deps, actor, payload.accountId, [resolution]);
    case 'void_contribution':
      return applyContributionVoid(deps, actor, payload.contributionId, [resolution]);
    case 'correct_transaction': {
      const rows = await deps.db
        .select()
        .from(financialTransactions)
        .where(
          and(
            eq(financialTransactions.id, payload.transactionId),
            eq(financialTransactions.householdId, actor.scope.household.id),
            eq(financialTransactions.status, 'confirmed'),
          ),
        )
        .limit(1);
      if (!rows[0])
        return { statements: [resolution], replies: [{ text: 'Lançamento não encontrado.' }] };
      return applyCorrection(deps, actor, rows[0], payload.field, payload.value, [resolution]);
    }
  }
}

function cancel(deps: Deps, row: PendingRow): Effect {
  return {
    statements: [resolvePendingStatement(deps, row.id, 'cancelled')],
    replies: [{ text: 'Cancelado. Nada foi alterado.' }],
  };
}

/** Clique em botao: confere dono, Household, validade e permissao de escrita. */
export async function handleButton(
  deps: Deps,
  actor: Actor,
  action: 'c' | 'x',
  pendingId: string,
): Promise<Effect> {
  const rows = await deps.db
    .select()
    .from(pendingActions)
    .where(
      and(
        eq(pendingActions.id, pendingId),
        eq(pendingActions.householdId, actor.scope.household.id),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || row.status !== 'pending' || row.expiresAt <= deps.now()) {
    return replyOnly('Essa confirmação não está mais válida.');
  }
  if (row.memberId !== actor.member.id && !canAdminister(actor.member)) {
    return replyOnly('Só quem pediu (ou um administrador) pode responder a essa confirmação.');
  }
  if (!canWrite(actor.member)) return replyOnly('Seu perfil é somente leitura.');
  return action === 'c' ? executeConfirmation(deps, actor, row) : cancel(deps, row);
}

/** Respostas curtas a uma pendencia aberta. Retorna null quando a mensagem nao e sobre ela. */
export async function handlePendingReply(
  deps: Deps,
  actor: Actor,
  text: string,
): Promise<Effect | null> {
  const row = await latestPending(deps, actor);
  if (!row || !canWrite(actor.member)) return null;
  const payload = parsePayload(row);

  if (payload.type === 'onboarding') return onboardingAnswer(deps, actor, payload.step, text);
  if (payload.type !== 'fill_slot') {
    if (isAffirmative(text)) return executeConfirmation(deps, actor, row);
    if (isNegative(text)) return cancel(deps, row);
    return null;
  }

  if (isNegative(text)) return cancel(deps, row);
  const context = ledgerContext(actor);
  const draft = payload.drafts[payload.index];
  if (!draft) return null;
  const filled = applySlotAnswer(draft, payload.slot, text, context, payload.candidateCents);
  if (!filled) return null;
  const drafts = payload.drafts.map((d, i) => (i === payload.index ? filled : d));
  return recordDrafts(deps, actor, drafts, {
    origin: payload.origin,
    idempotencyPrefix: `pending:${row.id}`,
    // A lacuna preenchida nao dispensa a confirmacao que ja era exigida.
    confirmationReason: payload.confirmationReason ?? null,
    extraStatements: [resolvePendingStatement(deps, row.id, 'confirmed')],
  });
}

export async function confirmLatest(deps: Deps, actor: Actor, confirm: boolean): Promise<Effect> {
  const row = await latestPending(deps, actor);
  if (!row) return replyOnly('Não tenho nenhuma confirmação pendente.');
  return confirm ? executeConfirmation(deps, actor, row) : cancel(deps, row);
}
