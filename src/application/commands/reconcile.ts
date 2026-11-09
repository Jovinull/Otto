import { and, eq } from 'drizzle-orm';
import { matchAccount } from '../../domain/finance/transactions';
import type { Stmt } from '../../infrastructure/database/client';
import { balanceReconciliations, financialAccounts } from '../../infrastructure/database/schema';
import { formatDate } from '../../shared/dates';
import { formatBRL, parseBRL } from '../../shared/money';
import type { Actor, Deps, Effect } from '../context';
import { replyOnly } from '../context';
import { accountBalances } from '../queries/finance';
import { confirmationButtons, createPendingStatement } from './record-transactions';
import { auditStatement } from './shared';

/**
 * Compara o saldo informado com o calculado. Nunca altera o historico: a diferenca so entra no
 * saldo depois de aprovada, como um ajuste separado e auditavel.
 */
export async function reportBalance(
  deps: Deps,
  actor: Actor,
  accountText: string,
  amountText: string,
): Promise<Effect> {
  const accounts = actor.scope.accounts.filter((a) => a.kind !== 'credit_card');
  const match = matchAccount(accountText.replaceAll('_', ' '), accounts, {
    memberId: actor.member.id,
  });
  if (match.status === 'ambiguous') {
    return replyOnly(`Qual delas? ${match.options.map((a) => a.name).join(', ')}.`);
  }
  if (match.status !== 'found') {
    return replyOnly(`Não achei a conta "${accountText}". Veja /contas.`);
  }
  const account = match.account;
  const isZero = /^0+(,0{1,2})?$/.test(amountText.trim());
  const parsed = isZero ? ({ status: 'ok', cents: 0 } as const) : parseBRL(amountText);
  if (parsed.status !== 'ok') return replyOnly('Valor inválido. Exemplo: /saldo Nubank 830,00');
  const reported = parsed.cents;

  const position = (await accountBalances(deps.db, actor.scope)).find((p) => p.id === account.id);
  if (!position) return replyOnly('Conta não encontrada.');

  if (position.balanceCents === null) {
    const opening = reported - position.netMovementCents;
    return {
      statements: [
        deps.db
          .update(financialAccounts)
          .set({ openingBalanceCents: opening, openingBalanceDate: actor.today })
          .where(
            and(
              eq(financialAccounts.id, account.id),
              eq(financialAccounts.householdId, actor.scope.household.id),
            ),
          ),
        auditStatement(deps, actor, 'account.balance_informed', 'account', account.id, {
          before: { openingBalanceCents: null },
          after: { openingBalanceCents: opening, reportedCents: reported },
        }),
      ],
      replies: [
        {
          text: `Anotado: ${account.name} com ${formatBRL(reported)} em ${formatDate(actor.today)}. A partir de agora conheço o saldo dessa conta.`,
        },
      ],
    };
  }

  const difference = reported - position.balanceCents;
  if (difference === 0) {
    return replyOnly(`${account.name} bate: ${formatBRL(reported)} aqui e no banco. ✅`);
  }

  const id = deps.newId();
  const pendingId = deps.newId();
  const direction = difference > 0 ? 'a mais' : 'a menos';
  return {
    statements: [
      deps.db.insert(balanceReconciliations).values({
        id,
        householdId: actor.scope.household.id,
        accountId: account.id,
        referenceDate: actor.today,
        calculatedCents: position.balanceCents,
        reportedCents: reported,
        differenceCents: difference,
        memberId: actor.member.id,
        idempotencyKey: `${actor.eventId}:reconcile`,
        createdAt: deps.now(),
      }),
      auditStatement(deps, actor, 'reconciliation.opened', 'account', account.id, {
        after: { calculatedCents: position.balanceCents, reportedCents: reported },
      }),
      createPendingStatement(deps, actor, pendingId, {
        type: 'reconcile',
        reconciliationId: id,
      }),
    ],
    replies: [
      {
        text: [
          `${account.name}: calculei ${formatBRL(position.balanceCents)} e você informou ${formatBRL(reported)}.`,
          `Diferença de ${formatBRL(Math.abs(difference))} ${direction}. Não sei a causa: pode ter faltado algum lançamento.`,
          'Confirmar registra um ajuste no saldo, sem mexer nos lançamentos nem contar como gasto ou receita. Cancelar deixa como está para você lançar o que faltou.',
        ].join('\n'),
        buttons: confirmationButtons(pendingId),
      },
    ],
  };
}

export async function resolveReconciliation(
  deps: Deps,
  actor: Actor,
  reconciliationId: string,
  outcome: 'adjusted' | 'dismissed',
  extra: Stmt[],
): Promise<Effect> {
  const rows = await deps.db
    .select()
    .from(balanceReconciliations)
    .where(
      and(
        eq(balanceReconciliations.id, reconciliationId),
        eq(balanceReconciliations.householdId, actor.scope.household.id),
        eq(balanceReconciliations.status, 'pending'),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return { statements: extra, replies: [{ text: 'Reconciliação não encontrada.' }] };
  return {
    statements: [
      ...extra,
      deps.db
        .update(balanceReconciliations)
        .set({ status: outcome, resolvedAt: deps.now() })
        .where(eq(balanceReconciliations.id, row.id)),
      auditStatement(deps, actor, `reconciliation.${outcome}`, 'account', row.accountId, {
        after: { differenceCents: row.differenceCents },
      }),
    ],
    replies: [
      {
        text:
          outcome === 'adjusted'
            ? `Ajuste registrado: saldo agora é ${formatBRL(row.reportedCents)}.`
            : 'Cancelado. O saldo segue como estava; lance o que faltou.',
      },
    ],
  };
}
