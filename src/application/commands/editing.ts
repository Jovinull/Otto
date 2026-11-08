import { and, eq, isNull } from 'drizzle-orm';
import type { ScheduleType } from '../../domain/finance/recurring';
import { matchAccount } from '../../domain/finance/transactions';
import type { Stmt } from '../../infrastructure/database/client';
import {
  budgets,
  categories,
  financialAccounts,
  recurringEntries,
} from '../../infrastructure/database/schema';
import { formatBRL, parseBRL } from '../../shared/money';
import { normalizeText } from '../../shared/text';
import type { Account, Actor, Deps, Effect } from '../context';
import { replyOnly } from '../context';
import { findCategoryByText, findMember, normalizedRecurringName } from './planning';
import { confirmationButtons, createPendingStatement } from './record-transactions';
import { auditStatement } from './shared';

/** Valores de opcoes nao tem espacos: `nome=Nubank_Felipe` vira "Nubank Felipe". */
const spaced = (value: string): string => value.replaceAll('_', ' ').trim();
const CLEAR = new Set(['-', 'nenhum', 'nenhuma', '?']);
const ZERO = /^0+(,0{1,2})?$/;

type AccountLookup = { account: Account } | { error: string };

function findAccount(actor: Actor, name: string): AccountLookup {
  const accounts = actor.scope.accounts;
  const exact = accounts.find((a) => a.normalizedName === normalizeText(name));
  if (exact) return { account: exact };
  const match = matchAccount(name, accounts);
  if (match.status === 'found') {
    return { account: accounts.find((a) => a.id === match.account.id)! };
  }
  const list = accounts.map((a) => a.name).join(', ') || 'nenhuma';
  return { error: `Não achei a conta "${name}". Contas: ${list}.` };
}

function parseDay(value: string): number | null | 'invalid' {
  if (CLEAR.has(value)) return null;
  const day = Number(value);
  return Number.isInteger(day) && day >= 1 && day <= 31 ? day : 'invalid';
}

export interface AccountChanges {
  name?: string | undefined;
  opening?: string | undefined;
  closingDay?: string | undefined;
  dueDay?: string | undefined;
  owner?: string | undefined;
  makeDefault: boolean;
}

/** Edita uma conta. Mudar o saldo inicial muda os saldos derivados, por isso fica auditado. */
export function editAccount(
  deps: Deps,
  actor: Actor,
  accountName: string,
  changes: AccountChanges,
): Effect {
  const lookup = findAccount(actor, accountName);
  if ('error' in lookup) return replyOnly(lookup.error);
  const account = lookup.account;
  const isCard = account.kind === 'credit_card';
  const set: Partial<typeof financialAccounts.$inferInsert> = {};
  const notes: string[] = [];

  if (changes.name !== undefined) {
    const name = spaced(changes.name);
    const normalizedName = normalizeText(name);
    if (!normalizedName) return replyOnly('Nome inválido.');
    const taken = actor.scope.accounts.some(
      (a) => a.id !== account.id && a.normalizedName === normalizedName,
    );
    if (taken) return replyOnly('Já existe outra conta com esse nome.');
    set.name = name;
    set.normalizedName = normalizedName;
    notes.push(`nome: ${name}`);
  }

  if (changes.opening !== undefined) {
    if (isCard) return replyOnly('Cartão não tem saldo inicial.');
    if (CLEAR.has(changes.opening)) {
      set.openingBalanceCents = null;
      notes.push('saldo inicial: desconhecido');
    } else if (ZERO.test(changes.opening)) {
      set.openingBalanceCents = 0;
      notes.push(`saldo inicial: ${formatBRL(0)}`);
    } else {
      const parsed = parseBRL(changes.opening);
      if (parsed.status !== 'ok') {
        return replyOnly('Saldo inválido. Exemplo: saldo=1200,50, ou saldo=? para desconhecido.');
      }
      set.openingBalanceCents = parsed.cents;
      notes.push(`saldo inicial: ${formatBRL(parsed.cents)}`);
    }
  }

  const days = [
    { raw: changes.closingDay, field: 'creditClosingDay', option: 'fecha', label: 'fechamento' },
    { raw: changes.dueDay, field: 'creditDueDay', option: 'vence', label: 'vencimento' },
  ] as const;
  for (const { raw, field, option, label } of days) {
    if (raw === undefined) continue;
    if (!isCard) return replyOnly('Dias de fechamento e vencimento só valem para cartão.');
    const day = parseDay(raw);
    if (day === 'invalid') {
      return replyOnly(`Dia inválido em ${option}=. Use 1 a 31, ou - para apagar.`);
    }
    set[field] = day;
    notes.push(`${label}: ${day === null ? 'não informado' : `dia ${day}`}`);
  }

  if (changes.owner !== undefined) {
    if (CLEAR.has(changes.owner) || normalizeText(changes.owner) === 'casal') {
      set.ownerMemberId = null;
      notes.push('dono: casal');
    } else {
      const member = findMember(actor, spaced(changes.owner));
      if (!member) return replyOnly(`Não encontrei "${changes.owner}" no cadastro.`);
      set.ownerMemberId = member.id;
      notes.push(`dono: ${member.name}`);
    }
  }

  const householdId = actor.scope.household.id;
  const statements: Stmt[] = [];
  if (changes.makeDefault) {
    if (isCard || account.kind === 'reserve') {
      return replyOnly('Cartão e reserva não podem ser conta padrão.');
    }
    statements.push(
      deps.db
        .update(financialAccounts)
        .set({ isDefault: false })
        .where(eq(financialAccounts.householdId, householdId)),
    );
    set.isDefault = true;
    notes.push('conta padrão da casa');
  }

  if (notes.length === 0) {
    return replyOnly(
      'Nada para alterar. Exemplo: /editconta Nubank fecha=3 vence=10 (veja /ajuda editar).',
    );
  }

  const before = Object.fromEntries(
    Object.keys(set).map((key) => [key, account[key as keyof Account]]),
  );
  statements.push(
    deps.db
      .update(financialAccounts)
      .set(set)
      .where(
        and(eq(financialAccounts.id, account.id), eq(financialAccounts.householdId, householdId)),
      ),
    auditStatement(deps, actor, 'account.updated', 'account', account.id, { before, after: set }),
  );
  return {
    statements,
    replies: [{ text: `Conta ${account.name} atualizada: ${notes.join(', ')}.` }],
  };
}

export function requestArchiveAccount(deps: Deps, actor: Actor, accountName: string): Effect {
  const lookup = findAccount(actor, accountName);
  if ('error' in lookup) return replyOnly(lookup.error);
  const pendingId = deps.newId();
  return {
    statements: [
      createPendingStatement(deps, actor, pendingId, {
        type: 'archive_account',
        accountId: lookup.account.id,
      }),
    ],
    replies: [
      {
        text: `Arquivar a conta ${lookup.account.name}? Ela sai das listas e não recebe novos lançamentos; o histórico e os totais continuam.`,
        buttons: confirmationButtons(pendingId),
      },
    ],
  };
}

export async function applyArchiveAccount(
  deps: Deps,
  actor: Actor,
  accountId: string,
  extra: Stmt[],
): Promise<Effect> {
  const rows = await deps.db
    .select()
    .from(financialAccounts)
    .where(
      and(
        eq(financialAccounts.id, accountId),
        eq(financialAccounts.householdId, actor.scope.household.id),
        isNull(financialAccounts.archivedAt),
      ),
    )
    .limit(1);
  const account = rows[0];
  if (!account) return { statements: extra, replies: [{ text: 'Conta não encontrada.' }] };
  const now = deps.now();
  return {
    statements: [
      ...extra,
      deps.db
        .update(financialAccounts)
        .set({ archivedAt: now, isDefault: false })
        .where(eq(financialAccounts.id, account.id)),
      auditStatement(deps, actor, 'account.archived', 'account', account.id, {
        before: { archivedAt: null },
        after: { archivedAt: now },
      }),
    ],
    replies: [{ text: `Conta ${account.name} arquivada.` }],
  };
}

const NATURES = {
  essencial: 'essential',
  discricionaria: 'discretionary',
  outra: 'other',
} as const;

export function editCategory(
  deps: Deps,
  actor: Actor,
  categoryText: string,
  changes: { name?: string | undefined; nature?: string | undefined },
): Effect {
  const category =
    findCategoryByText(actor, categoryText, 'expense') ??
    findCategoryByText(actor, categoryText, 'income');
  if (!category) return replyOnly('Categoria não encontrada. Veja /categorias.');

  const set: Partial<typeof categories.$inferInsert> = {};
  if (changes.name !== undefined) {
    const name = spaced(changes.name);
    if (!name) return replyOnly('Nome inválido.');
    set.name = name;
  }
  if (changes.nature !== undefined) {
    const nature = NATURES[normalizeText(changes.nature) as keyof typeof NATURES];
    if (!nature) return replyOnly('Tipo inválido: essencial, discricionaria ou outra.');
    set.nature = nature;
  }
  if (Object.keys(set).length === 0) {
    return replyOnly(
      'Nada para alterar. Exemplo: /editcategoria lazer nome=Passeios tipo=discricionaria',
    );
  }
  return {
    statements: [
      deps.db
        .update(categories)
        .set(set)
        .where(
          and(eq(categories.id, category.id), eq(categories.householdId, actor.scope.household.id)),
        ),
      auditStatement(deps, actor, 'category.updated', 'category', category.id, {
        before: { name: category.name, nature: category.nature },
        after: set,
      }),
    ],
    replies: [
      { text: `Categoria atualizada: ${set.name ?? category.name} (código ${category.slug}).` },
    ],
  };
}

type RecurringRow = typeof recurringEntries.$inferSelect;

async function findRecurring(
  deps: Deps,
  actor: Actor,
  name: string,
): Promise<{ entry: RecurringRow } | { error: string }> {
  const normalized = normalizedRecurringName(spaced(name));
  const rows = await deps.db
    .select()
    .from(recurringEntries)
    .where(
      and(
        eq(recurringEntries.householdId, actor.scope.household.id),
        eq(recurringEntries.active, true),
        eq(recurringEntries.normalizedDescription, normalized),
      ),
    );
  if (rows.length === 1) return { entry: rows[0]! };
  return {
    error:
      rows.length === 0
        ? `Não encontrei o compromisso "${name}". Veja /compromissos.`
        : `Há mais de um compromisso chamado "${name}". Remova com /removerrecorrente e cadastre de novo.`,
  };
}

export async function editRecurring(
  deps: Deps,
  actor: Actor,
  name: string,
  changes: {
    amount?: string | undefined;
    day?: string | undefined;
    businessDay?: string | undefined;
  },
): Promise<Effect> {
  const found = await findRecurring(deps, actor, name);
  if ('error' in found) return replyOnly(found.error);
  const entry = found.entry;
  const set: {
    amountCents?: number | null;
    scheduleType?: ScheduleType;
    scheduleValue?: number | null;
  } = {};
  const notes: string[] = [];

  if (changes.amount !== undefined) {
    if (CLEAR.has(changes.amount)) {
      set.amountCents = null;
      notes.push('valor variável');
    } else {
      const parsed = parseBRL(changes.amount);
      if (parsed.status !== 'ok') {
        return replyOnly('Valor inválido. Exemplo: valor=1250,00, ou valor=? para variável.');
      }
      set.amountCents = parsed.cents;
      notes.push(`valor ${formatBRL(parsed.cents)}`);
    }
  }
  if (changes.day !== undefined && changes.businessDay !== undefined) {
    return replyOnly('Use dia= ou util=, não os dois.');
  }
  if (changes.day !== undefined) {
    const day = Number(changes.day);
    if (!Number.isInteger(day) || day < 1 || day > 31)
      return replyOnly('Dia inválido. Use 1 a 31.');
    set.scheduleType = 'monthly_day';
    set.scheduleValue = day;
    notes.push(`todo dia ${day}`);
  }
  if (changes.businessDay !== undefined) {
    const n = Number(changes.businessDay);
    if (!Number.isInteger(n) || n < 1 || n > 23) {
      return replyOnly('Dia útil inválido. Use 1 a 23.');
    }
    set.scheduleType = 'nth_weekday_approx';
    set.scheduleValue = n;
    notes.push(`${n}º dia útil (aproximado, sem feriados)`);
  }
  if (notes.length === 0) {
    return replyOnly('Nada para alterar. Exemplo: /editrecorrente aluguel valor=1300 dia=10');
  }
  return {
    statements: [
      deps.db.update(recurringEntries).set(set).where(eq(recurringEntries.id, entry.id)),
      auditStatement(deps, actor, 'recurring.updated', 'recurring', entry.id, {
        before: {
          amountCents: entry.amountCents,
          scheduleType: entry.scheduleType,
          scheduleValue: entry.scheduleValue,
        },
        after: set,
      }),
    ],
    replies: [{ text: `${entry.description} atualizado: ${notes.join(', ')}.` }],
  };
}

/** Desativa o compromisso. Os pagamentos ja registrados nao mudam. */
export async function removeRecurring(deps: Deps, actor: Actor, name: string): Promise<Effect> {
  const found = await findRecurring(deps, actor, name);
  if ('error' in found) return replyOnly(found.error);
  return {
    statements: [
      deps.db
        .update(recurringEntries)
        .set({ active: false })
        .where(eq(recurringEntries.id, found.entry.id)),
      auditStatement(deps, actor, 'recurring.deactivated', 'recurring', found.entry.id, {
        before: { active: true },
        after: { active: false },
      }),
    ],
    replies: [
      {
        text: `${found.entry.description} não é mais um compromisso previsto. Lançamentos antigos continuam.`,
      },
    ],
  };
}

export async function removeBudget(
  deps: Deps,
  actor: Actor,
  categoryText: string,
  personText: string | null,
): Promise<Effect> {
  const isTotal = normalizeText(categoryText) === 'total';
  const category = isTotal ? null : findCategoryByText(actor, categoryText, 'expense');
  if (!isTotal && !category) return replyOnly('Categoria não encontrada. Veja /categorias.');
  const member = personText ? findMember(actor, personText) : null;
  if (personText && !member) return replyOnly(`Não encontrei "${personText}" no cadastro.`);

  const rows = await deps.db
    .select()
    .from(budgets)
    .where(and(eq(budgets.householdId, actor.scope.household.id), isNull(budgets.archivedAt)));
  const budget = rows.find(
    (b) => b.categoryId === (category?.id ?? null) && b.memberId === (member?.id ?? null),
  );
  if (!budget) return replyOnly('Não há orçamento ativo com esse escopo. Veja /orcamento.');
  const now = deps.now();
  return {
    statements: [
      deps.db
        .update(budgets)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(budgets.id, budget.id)),
      auditStatement(deps, actor, 'budget.archived', 'budget', budget.id, {
        before: { limitCents: budget.limitCents },
        after: { archivedAt: now },
      }),
    ],
    replies: [
      {
        text: `Orçamento de ${category?.name ?? 'Geral'}${member ? ` de ${member.name}` : ''} removido.`,
      },
    ],
  };
}
