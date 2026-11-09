import { and, desc, eq, gt } from 'drizzle-orm';
import { canAdminister, canWrite } from '../../domain/household/authorization';
import {
  applySlotAnswer,
  isAffirmative,
  isNegative,
  matchAccount,
} from '../../domain/finance/transactions';
import { normalizeText } from '../../shared/text';
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
import { applyGoalArchive, moveGoalFunds } from '../commands/goals';
import { resolveReconciliation } from '../commands/reconcile';
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
    case 'archive_goal':
      return applyGoalArchive(deps, actor, payload.goalId, [resolution]);
    case 'reconcile':
      return resolveReconciliation(deps, actor, payload.reconciliationId, 'adjusted', [resolution]);
    case 'goal_move':
      return moveGoalFunds(deps, actor, payload.movement, `pending:${row.id}`, [resolution]);
    case 'goal_location':
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

async function cancel(deps: Deps, actor: Actor, row: PendingRow): Promise<Effect> {
  const payload = parsePayload(row);
  if (payload.type === 'reconcile') {
    return resolveReconciliation(deps, actor, payload.reconciliationId, 'dismissed', [
      resolvePendingStatement(deps, row.id, 'cancelled'),
    ]);
  }
  return {
    statements: [resolvePendingStatement(deps, row.id, 'cancelled')],
    replies: [{ text: 'Cancelado. Nada foi alterado.' }],
  };
}

/** Resposta a "onde esta esse dinheiro?": conta, transferencia ou desconhecido. */
function answerGoalLocation(
  deps: Deps,
  actor: Actor,
  row: PendingRow,
  payload: Extract<PendingPayload, { type: 'goal_location' }>,
  text: string,
): Promise<Effect> | null {
  const resolution = resolvePendingStatement(deps, row.id, 'confirmed');
  const prefix = `pending:${row.id}`;
  const value = normalizeText(text);
  if (value === 'nao sei')
    return moveGoalFunds(deps, actor, payload.movement, prefix, [resolution]);
  if (isNegative(text)) return cancel(deps, actor, row);
  const transfer = /^(?:de\s+)?(.+?)\s+(?:para|pra|pro|>)\s+(.+)$/i.exec(text.trim());
  const accounts = actor.scope.accounts.filter((a) => a.kind !== 'credit_card');
  const known = (name: string) =>
    matchAccount(name, accounts, { memberId: actor.member.id }).status === 'found';
  if (transfer && known(transfer[1]!) && known(transfer[2]!)) {
    return moveGoalFunds(
      deps,
      actor,
      { ...payload.movement, sourceAccountText: transfer[1]!, accountText: transfer[2]! },
      prefix,
      [resolution],
    );
  }
  if (known(text.trim())) {
    return moveGoalFunds(deps, actor, { ...payload.movement, accountText: text.trim() }, prefix, [
      resolution,
    ]);
  }
  return null;
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
  return action === 'c' ? executeConfirmation(deps, actor, row) : cancel(deps, actor, row);
}

/** Respostas curtas a uma pendencia aberta. Retorna null quando a mensagem nao e sobre ela. */
export async function handlePendingReply(
  deps: Deps,
  actor: Actor,
  text: string,
): Promise<Effect | null> {
  const row = actor.latestPending;
  if (!row || !canWrite(actor.member)) return null;
  const payload = parsePayload(row);

  if (payload.type === 'onboarding') return onboardingAnswer(deps, actor, payload.step, text);
  if (payload.type === 'goal_location') return answerGoalLocation(deps, actor, row, payload, text);
  if (payload.type !== 'fill_slot') {
    if (isAffirmative(text)) return executeConfirmation(deps, actor, row);
    if (isNegative(text)) return cancel(deps, actor, row);
    return null;
  }

  if (isNegative(text)) return cancel(deps, actor, row);
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
  return confirm ? executeConfirmation(deps, actor, row) : cancel(deps, actor, row);
}
