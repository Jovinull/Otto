import { and, eq } from 'drizzle-orm';
import type { TransactionDraft } from '../../domain/finance/transactions';
import { matchAccount } from '../../domain/finance/transactions';
import type { ScheduleType } from '../../domain/finance/recurring';
import { recurringEntries, recurringSettlements } from '../../infrastructure/database/schema';
import { periodOf } from '../../shared/dates';
import { formatBRL, parseBRL } from '../../shared/money';
import { normalizeText } from '../../shared/text';
import type { Actor, Deps, Effect, Member } from '../context';
import { replyOnly } from '../context';
import { addCommitment, findMember, normalizedRecurringName } from './planning';
import { matchedAmountInPeriod, recordDrafts } from './record-transactions';

export type IncomeSource = typeof recurringEntries.$inferSelect;

export interface IncomeSetup {
  amountText: string | null;
  name: string | null;
  scheduleType: ScheduleType;
  scheduleValue: number | null;
  accountText: string | null;
  personText: string | null;
  irregular: boolean;
}

const DEFAULT_SOURCE = 'Salário';

/** Configurar uma renda nunca registra dinheiro recebido. */
export async function configureIncome(
  deps: Deps,
  actor: Actor,
  input: IncomeSetup,
): Promise<Effect> {
  const person = input.personText ? findMember(actor, input.personText) : actor.member;
  if (!person) return replyOnly(`Não encontrei "${input.personText}" no cadastro.`);
  let accountId: string | null = null;
  if (input.accountText) {
    const accounts = actor.scope.accounts.filter((a) => a.kind !== 'credit_card');
    const match = matchAccount(input.accountText.replaceAll('_', ' '), accounts, {
      memberId: person.id,
    });
    if (match.status === 'ambiguous') {
      return replyOnly(`Qual delas? ${match.options.map((a) => a.name).join(', ')}.`);
    }
    if (match.status !== 'found') {
      return replyOnly(`Não achei a conta "${input.accountText}". Veja /contas.`);
    }
    accountId = match.account.id;
  }
  const name = input.name?.replaceAll('_', ' ').trim() || DEFAULT_SOURCE;
  return addCommitment(deps, actor, {
    kind: 'income',
    description: name,
    amountText: input.amountText,
    scheduleType: input.scheduleType,
    scheduleValue: input.scheduleValue,
    personText: person.name,
    categoryText: normalizeText(name) === 'salario' ? 'salario' : null,
    accountId,
    frequency: input.irregular ? 'irregular' : 'monthly',
  });
}

async function loadSources(deps: Deps, actor: Actor, member: Member): Promise<IncomeSource[]> {
  const rows = await deps.db
    .select()
    .from(recurringEntries)
    .where(
      and(
        eq(recurringEntries.householdId, actor.scope.household.id),
        eq(recurringEntries.kind, 'income'),
        eq(recurringEntries.active, true),
      ),
    );
  return rows.filter((row) => row.memberId === member.id);
}

async function settledThisPeriod(
  deps: Deps,
  source: IncomeSource,
  period: string,
): Promise<boolean> {
  const rows = await deps.db
    .select({ id: recurringSettlements.id })
    .from(recurringSettlements)
    .where(
      and(eq(recurringSettlements.entryId, source.id), eq(recurringSettlements.period, period)),
    )
    .limit(1);
  return rows.length > 0;
}

const amountToText = (cents: number): string => (cents / 100).toFixed(2).replace('.', ',');

export interface ReceiptInput {
  nameText: string | null;
  amountText: string | null;
  accountText: string | null;
  personText: string | null;
  dateText: string | null;
}

/** Marca o recebimento de uma fonte cadastrada. Sem valor, usa o previsto e o que ainda falta. */
export async function receiveIncome(
  deps: Deps,
  actor: Actor,
  input: ReceiptInput,
): Promise<Effect> {
  const person = input.personText ? findMember(actor, input.personText) : actor.member;
  if (!person) return replyOnly(`Não encontrei "${input.personText}" no cadastro.`);
  const sources = await loadSources(deps, actor, person);
  if (sources.length === 0) {
    return replyOnly(
      `${person.name} não tem renda cadastrada. Para uma entrada avulsa use /receita VALOR descrição, ou cadastre com /renda.`,
    );
  }
  let source: IncomeSource | undefined;
  if (input.nameText) {
    const wanted = normalizedRecurringName(input.nameText);
    const matches = sources.filter(
      (s) => s.normalizedDescription.includes(wanted) || wanted.includes(s.normalizedDescription),
    );
    if (matches.length > 1) {
      return replyOnly(`Qual delas? ${matches.map((s) => s.description).join(', ')}.`);
    }
    source = matches[0];
    if (!source) {
      return replyOnly(
        `Não achei a renda "${input.nameText}". Rendas de ${person.name}: ${sources.map((s) => s.description).join(', ')}. Para uma entrada avulsa use /receita.`,
      );
    }
  } else if (sources.length === 1) {
    source = sources[0];
  } else {
    return replyOnly(`Qual renda? ${sources.map((s) => s.description).join(', ')}.`);
  }
  const entry = source!;
  const period = periodOf(actor.today);
  if (await settledThisPeriod(deps, entry, period)) {
    return replyOnly(
      `${entry.description} deste mês já está marcado como recebido. Se foi outra entrada, use /receita.`,
    );
  }

  let amountCents: number;
  if (input.amountText) {
    const parsed = parseBRL(input.amountText);
    if (parsed.status !== 'ok') return replyOnly('Valor inválido. Exemplo: /recebi salario 2000');
    amountCents = parsed.cents;
  } else if (entry.amountCents === null) {
    return replyOnly(
      `${entry.description} tem valor variável. Quanto caiu? Ex.: /recebi ${entry.description} 2000`,
    );
  } else {
    amountCents = entry.amountCents - (await matchedAmountInPeriod(deps, actor, entry, period));
    if (amountCents <= 0) {
      return replyOnly(`${entry.description} deste mês já foi recebido por completo.`);
    }
  }

  const draft: TransactionDraft = {
    kind: 'income',
    amountText: amountToText(amountCents),
    amountCents,
    description: entry.description,
    categorySlug: actor.scope.categories.find((c) => c.id === entry.categoryId)?.slug ?? null,
    personText: person.name,
    isShared: false,
    sourceAccountText: null,
    destinationAccountText: input.accountText?.replaceAll('_', ' ') ?? null,
    dateText: input.dateText,
    paymentMethod: 'unknown',
    installments: null,
    ...(!input.accountText && entry.accountId ? { destinationAccountId: entry.accountId } : {}),
  };
  return recordDrafts(deps, actor, [draft], {
    origin: 'command',
    idempotencyPrefix: actor.eventId,
  });
}

export interface IncomePreparation {
  drafts: TransactionDraft[];
  reason: string | null;
  stop: Effect | null;
}

/**
 * Aplica a fonte cadastrada a "meu salario caiu": conta e valor previstos so entram quando a
 * fonte e inequivoca, e sem valor explicito o registro passa por confirmacao.
 */
export async function prepareIncomeDrafts(
  deps: Deps,
  actor: Actor,
  drafts: readonly TransactionDraft[],
): Promise<IncomePreparation> {
  const result: TransactionDraft[] = [];
  let reason: string | null = null;
  const period = periodOf(actor.today);
  const cache = new Map<string, IncomeSource[]>();
  for (const draft of drafts) {
    const needsHelp =
      draft.kind === 'income' &&
      (draft.amountText === null || (!draft.destinationAccountText && !draft.destinationAccountId));
    if (!needsHelp) {
      result.push(draft);
      continue;
    }
    const person = draft.personText ? findMember(actor, draft.personText) : actor.member;
    if (!person) {
      result.push(draft);
      continue;
    }
    const sources = cache.get(person.id) ?? (await loadSources(deps, actor, person));
    cache.set(person.id, sources);
    const text = normalizedRecurringName(draft.description);
    const matches = sources.filter((s) => ` ${text} `.includes(` ${s.normalizedDescription} `));
    const source = matches.length === 1 ? matches[0]! : null;
    if (!source) {
      result.push(draft);
      continue;
    }
    const next: TransactionDraft = {
      ...draft,
      ...(!draft.destinationAccountText && source.accountId
        ? { destinationAccountId: source.accountId }
        : {}),
    };
    if (draft.amountText === null) {
      if (await settledThisPeriod(deps, source, period)) {
        return {
          drafts: [],
          reason: null,
          stop: replyOnly(`${source.description} deste mês já está marcado como recebido.`),
        };
      }
      if (source.amountCents !== null) {
        const remaining =
          source.amountCents - (await matchedAmountInPeriod(deps, actor, source, period));
        if (remaining > 0) {
          next.amountText = amountToText(remaining);
          next.amountCents = remaining;
          reason = `Vou usar o valor previsto de ${source.description}: ${formatBRL(remaining)}.`;
        }
      }
    }
    result.push(next);
  }
  return { drafts: result, reason, stop: null };
}
