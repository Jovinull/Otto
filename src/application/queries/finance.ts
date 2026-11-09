import { and, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import type { BudgetStatus } from '../../domain/budgets/budget';
import { computeBudgetStatus } from '../../domain/budgets/budget';
import type { ExpectedDate } from '../../domain/finance/recurring';
import { expectedDate } from '../../domain/finance/recurring';
import type { Db } from '../../infrastructure/database/client';
import {
  balanceReconciliations,
  budgetAlerts,
  budgets,
  categories,
  financialAccounts,
  financialTransactions as tx,
  goalContributions,
  financialGoals,
  installmentPlans,
  installments,
  recurringEntries,
  recurringSettlements,
} from '../../infrastructure/database/schema';
import type { DateRange, Period } from '../../shared/dates';
import { monthRange, periodOf } from '../../shared/dates';
import type { GoalProgress } from '../../domain/goals/goal';
import { computeGoalProgress } from '../../domain/goals/goal';
import type { Scope } from '../context';

const sumAmount = sql<number>`coalesce(sum(${tx.amountCents}), 0)`;
const countRows = sql<number>`count(*)`;

function expenseFilter(householdId: string, range: DateRange) {
  return and(
    eq(tx.householdId, householdId),
    eq(tx.status, 'confirmed'),
    eq(tx.type, 'expense'),
    gte(tx.financialDate, range.from),
    lte(tx.financialDate, range.to),
  );
}

export interface ExpenseFilter {
  categoryId?: string | undefined;
  memberId?: string | undefined;
  /** Exclui gastos marcados como do casal (orcamento individual). */
  onlyIndividual?: boolean | undefined;
}

export interface Total {
  totalCents: number;
  count: number;
}

export async function sumExpenses(
  db: Db,
  householdId: string,
  range: DateRange,
  filter: ExpenseFilter = {},
): Promise<Total> {
  const [row] = await db
    .select({ totalCents: sumAmount, count: countRows })
    .from(tx)
    .where(
      and(
        expenseFilter(householdId, range),
        filter.categoryId ? eq(tx.categoryId, filter.categoryId) : undefined,
        filter.memberId ? eq(tx.memberId, filter.memberId) : undefined,
        filter.onlyIndividual ? eq(tx.isShared, false) : undefined,
      ),
    );
  return row ?? { totalCents: 0, count: 0 };
}

export interface CategoryTotal {
  categoryId: string | null;
  name: string;
  slug: string;
  nature: string;
  totalCents: number;
  count: number;
}

export async function expensesByCategory(
  db: Db,
  householdId: string,
  range: DateRange,
  memberId?: string,
): Promise<CategoryTotal[]> {
  const rows = await db
    .select({
      categoryId: tx.categoryId,
      name: categories.name,
      slug: categories.slug,
      nature: categories.nature,
      totalCents: sumAmount,
      count: countRows,
    })
    .from(tx)
    .leftJoin(categories, eq(tx.categoryId, categories.id))
    .where(and(expenseFilter(householdId, range), memberId ? eq(tx.memberId, memberId) : undefined))
    .groupBy(tx.categoryId)
    .orderBy(desc(sumAmount));
  return rows.map((row) => ({
    ...row,
    name: row.name ?? 'Sem categoria',
    slug: row.slug ?? '',
    nature: row.nature ?? 'other',
  }));
}

export interface PersonTotal {
  memberId: string;
  isShared: boolean;
  totalCents: number;
  count: number;
}

export async function expensesByPerson(
  db: Db,
  householdId: string,
  range: DateRange,
): Promise<PersonTotal[]> {
  return db
    .select({
      memberId: tx.memberId,
      isShared: tx.isShared,
      totalCents: sumAmount,
      count: countRows,
    })
    .from(tx)
    .where(expenseFilter(householdId, range))
    .groupBy(tx.memberId, tx.isShared);
}

export interface CashFlow {
  incomeCents: number;
  expenseCents: number;
  creditExpenseCents: number;
  internalTransferCents: number;
  cardPaymentCents: number;
}

/** Transferencias e pagamentos de fatura aparecem a parte: nunca somam em receita ou despesa. */
export async function cashFlow(db: Db, householdId: string, range: DateRange): Promise<CashFlow> {
  const rows = await db
    .select({
      type: tx.type,
      transferKind: tx.transferKind,
      accountKind: financialAccounts.kind,
      totalCents: sumAmount,
    })
    .from(tx)
    .leftJoin(financialAccounts, eq(tx.sourceAccountId, financialAccounts.id))
    .where(
      and(
        eq(tx.householdId, householdId),
        eq(tx.status, 'confirmed'),
        gte(tx.financialDate, range.from),
        lte(tx.financialDate, range.to),
      ),
    )
    .groupBy(tx.type, tx.transferKind, financialAccounts.kind);

  const flow: CashFlow = {
    incomeCents: 0,
    expenseCents: 0,
    creditExpenseCents: 0,
    internalTransferCents: 0,
    cardPaymentCents: 0,
  };
  for (const row of rows) {
    if (row.type === 'income') flow.incomeCents += row.totalCents;
    if (row.type === 'expense') {
      flow.expenseCents += row.totalCents;
      if (row.accountKind === 'credit_card') flow.creditExpenseCents += row.totalCents;
    }
    if (row.type === 'transfer') {
      if (row.transferKind === 'card_payment') flow.cardPaymentCents += row.totalCents;
      else flow.internalTransferCents += row.totalCents;
    }
  }
  return flow;
}

export interface AccountAllocation {
  goalId: string;
  goalName: string;
  cents: number;
}

export interface AccountBalance {
  id: string;
  name: string;
  kind: string;
  ownerMemberId: string | null;
  ownership: string;
  /** Nulo quando o saldo inicial nao foi informado: nao ha saldo real a afirmar. */
  balanceCents: number | null;
  /** Movimentacao liquida registrada no Otto. */
  netMovementCents: number;
  /** Parte do saldo destinada a metas ativas. */
  allocatedCents: number;
  allocations: AccountAllocation[];
}

/** Saldos sempre derivados dos lancamentos; nao existe coluna de saldo mutavel. */
export async function accountBalances(db: Db, scope: Scope): Promise<AccountBalance[]> {
  const householdId = scope.household.id;
  const confirmed = and(eq(tx.householdId, householdId), eq(tx.status, 'confirmed'));
  const [outflows, inflows, adjustments, reservations] = await db.batch([
    db
      .select({ accountId: tx.sourceAccountId, totalCents: sumAmount })
      .from(tx)
      .where(confirmed)
      .groupBy(tx.sourceAccountId),
    db
      .select({ accountId: tx.destinationAccountId, totalCents: sumAmount })
      .from(tx)
      .where(confirmed)
      .groupBy(tx.destinationAccountId),
    db
      .select({
        accountId: balanceReconciliations.accountId,
        totalCents: sql<number>`coalesce(sum(${balanceReconciliations.differenceCents}), 0)`,
      })
      .from(balanceReconciliations)
      .where(
        and(
          eq(balanceReconciliations.householdId, householdId),
          eq(balanceReconciliations.status, 'adjusted'),
        ),
      )
      .groupBy(balanceReconciliations.accountId),
    db
      .select({
        accountId: goalContributions.accountId,
        goalId: goalContributions.goalId,
        goalName: financialGoals.name,
        cents: sql<number>`coalesce(sum(case when ${goalContributions.direction} = 'in' then ${goalContributions.amountCents} else -${goalContributions.amountCents} end), 0)`,
      })
      .from(goalContributions)
      .innerJoin(financialGoals, eq(goalContributions.goalId, financialGoals.id))
      .where(
        and(
          eq(goalContributions.householdId, householdId),
          eq(goalContributions.status, 'confirmed'),
          eq(financialGoals.status, 'active'),
        ),
      )
      .groupBy(goalContributions.accountId, goalContributions.goalId),
  ]);
  const outByAccount = new Map(outflows.map((row) => [row.accountId, row.totalCents]));
  const inByAccount = new Map(inflows.map((row) => [row.accountId, row.totalCents]));
  const adjustedByAccount = new Map(adjustments.map((row) => [row.accountId, row.totalCents]));

  return scope.accounts.map((account) => {
    const net = (inByAccount.get(account.id) ?? 0) - (outByAccount.get(account.id) ?? 0);
    const adjusted = adjustedByAccount.get(account.id) ?? 0;
    const isCard = account.kind === 'credit_card';
    const allocations = reservations
      .filter((row) => row.accountId === account.id && row.cents > 0)
      .map((row) => ({ goalId: row.goalId, goalName: row.goalName, cents: row.cents }));
    return {
      id: account.id,
      name: account.name,
      kind: account.kind,
      ownerMemberId: account.ownerMemberId,
      ownership: account.ownership,
      balanceCents: isCard
        ? net + (account.openingBalanceCents ?? 0) + adjusted
        : account.openingBalanceCents === null
          ? null
          : account.openingBalanceCents + net + adjusted,
      netMovementCents: net,
      allocatedCents: allocations.reduce((sum, row) => sum + row.cents, 0),
      allocations,
    };
  });
}

export interface CommitmentView {
  id: string;
  kind: 'expense' | 'income';
  description: string;
  amountCents: number | null;
  expected: ExpectedDate;
  settled: boolean;
  memberId: string | null;
  accountId: string | null;
  frequency: 'monthly' | 'irregular';
}

export async function loadCommitments(
  db: Db,
  householdId: string,
  period: Period,
): Promise<CommitmentView[]> {
  const [entries, settlements] = await db.batch([
    db
      .select()
      .from(recurringEntries)
      .where(and(eq(recurringEntries.householdId, householdId), eq(recurringEntries.active, true))),
    db
      .select({ entryId: recurringSettlements.entryId })
      .from(recurringSettlements)
      .innerJoin(recurringEntries, eq(recurringSettlements.entryId, recurringEntries.id))
      .where(
        and(eq(recurringEntries.householdId, householdId), eq(recurringSettlements.period, period)),
      ),
  ]);
  const settled = new Set(settlements.map((s) => s.entryId));
  return entries
    .map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      description: entry.description,
      amountCents: entry.amountCents,
      expected: expectedDate(entry, period),
      settled: settled.has(entry.id),
      memberId: entry.memberId,
      accountId: entry.accountId,
      frequency: entry.frequency,
    }))
    .sort((a, b) => (a.expected.date ?? '9999').localeCompare(b.expected.date ?? '9999'));
}

export interface BudgetView {
  id: string;
  categoryId: string | null;
  categoryName: string;
  memberId: string | null;
  status: BudgetStatus;
  alerted: number[];
}

export interface ExtraExpense {
  categoryId: string | null;
  memberId: string;
  isShared: boolean;
  amountCents: number;
}

/**
 * Situacao dos orcamentos ativos no periodo.
 * `extras` soma despesas ainda nao gravadas, para a resposta refletir o lancamento em andamento.
 */
export async function loadBudgetViews(
  db: Db,
  scope: Scope,
  period: Period,
  extras: readonly ExtraExpense[] = [],
): Promise<BudgetView[]> {
  const householdId = scope.household.id;
  const range = monthRange(period);
  const [budgetRows, spentRows, alertRows] = await db.batch([
    db
      .select()
      .from(budgets)
      .where(and(eq(budgets.householdId, householdId), isNull(budgets.archivedAt))),
    db
      .select({
        categoryId: tx.categoryId,
        memberId: tx.memberId,
        isShared: tx.isShared,
        totalCents: sumAmount,
      })
      .from(tx)
      .where(expenseFilter(householdId, range))
      .groupBy(tx.categoryId, tx.memberId, tx.isShared),
    db
      .select({ budgetId: budgetAlerts.budgetId, threshold: budgetAlerts.threshold })
      .from(budgetAlerts)
      .innerJoin(budgets, eq(budgetAlerts.budgetId, budgets.id))
      .where(and(eq(budgets.householdId, householdId), eq(budgetAlerts.period, period))),
  ]);

  const spending = [
    ...spentRows,
    ...extras.map((extra) => ({
      categoryId: extra.categoryId,
      memberId: extra.memberId,
      isShared: extra.isShared,
      totalCents: extra.amountCents,
    })),
  ];
  const categoryNames = new Map(scope.categories.map((c) => [c.id, c.name]));

  return budgetRows.map((budget) => {
    const spent = spending
      .filter(
        (row) =>
          (budget.categoryId === null || row.categoryId === budget.categoryId) &&
          // Orcamento individual conta so gastos individuais da pessoa.
          (budget.memberId === null || (row.memberId === budget.memberId && !row.isShared)),
      )
      .reduce((total, row) => total + row.totalCents, 0);
    return {
      id: budget.id,
      categoryId: budget.categoryId,
      categoryName: budget.categoryId
        ? (categoryNames.get(budget.categoryId) ?? 'Categoria')
        : 'Geral',
      memberId: budget.memberId,
      status: computeBudgetStatus(budget.limitCents, spent),
      alerted: alertRows.filter((a) => a.budgetId === budget.id).map((a) => a.threshold),
    };
  });
}

export interface GoalLocation {
  /** Nulo: dinheiro reservado sem local informado. */
  accountId: string | null;
  accountName: string;
  cents: number;
}

export interface GoalView {
  id: string;
  name: string;
  kind: 'apartment' | 'general';
  ownerMemberId: string | null;
  emergencyReserveCents: number | null;
  deadline: string | null;
  notes: string | null;
  progress: GoalProgress;
  locations: GoalLocation[];
}

const UNKNOWN_LOCATION = 'local não informado';

export async function loadGoals(db: Db, householdId: string, today: string): Promise<GoalView[]> {
  const [goals, contributions] = await db.batch([
    db
      .select()
      .from(financialGoals)
      .where(and(eq(financialGoals.householdId, householdId), eq(financialGoals.status, 'active'))),
    db
      .select({
        goalId: goalContributions.goalId,
        direction: goalContributions.direction,
        amountCents: goalContributions.amountCents,
        contributionDate: goalContributions.contributionDate,
        kind: goalContributions.kind,
        accountId: goalContributions.accountId,
        accountName: financialAccounts.name,
      })
      .from(goalContributions)
      .leftJoin(financialAccounts, eq(goalContributions.accountId, financialAccounts.id))
      .where(
        and(
          eq(goalContributions.householdId, householdId),
          eq(goalContributions.status, 'confirmed'),
        ),
      ),
  ]);
  const currentPeriod = periodOf(today);
  return goals.map((goal) => {
    let confirmedCents = 0;
    let confirmedThisMonthCents = 0;
    const byLocation = new Map<string | null, GoalLocation>();
    for (const entry of contributions) {
      if (entry.goalId !== goal.id) continue;
      const signed = entry.direction === 'in' ? entry.amountCents : -entry.amountCents;
      confirmedCents += signed;
      const location = byLocation.get(entry.accountId) ?? {
        accountId: entry.accountId,
        accountName: entry.accountName ?? UNKNOWN_LOCATION,
        cents: 0,
      };
      location.cents += signed;
      byLocation.set(entry.accountId, location);
      // Saldo inicial e dinheiro ja existente: nao sao aporte feito no mes.
      if (entry.kind === 'contribution' && periodOf(entry.contributionDate) === currentPeriod) {
        confirmedThisMonthCents += signed;
      }
    }
    return {
      id: goal.id,
      name: goal.name,
      kind: goal.kind,
      ownerMemberId: goal.ownerMemberId,
      emergencyReserveCents: goal.emergencyReserveCents,
      deadline: goal.deadline,
      notes: goal.notes,
      locations: [...byLocation.values()].filter((l) => l.cents !== 0),
      progress: computeGoalProgress(
        {
          targetCents: goal.targetCents,
          entryCents: goal.entryCents,
          additionalCostsCents: goal.additionalCostsCents,
          deadline: goal.deadline,
          plannedMonthlyCents: goal.plannedMonthlyCents,
          confirmedCents,
          confirmedThisMonthCents,
        },
        today,
      ),
    };
  });
}

export interface TransactionRow {
  id: string;
  type: 'expense' | 'income' | 'transfer';
  amountCents: number;
  description: string;
  financialDate: string;
  categoryName: string | null;
  memberId: string;
  transferKind: string | null;
}

export async function recentTransactions(
  db: Db,
  householdId: string,
  limit: number,
): Promise<TransactionRow[]> {
  const rows = await db
    .select({
      id: tx.id,
      type: tx.type,
      amountCents: tx.amountCents,
      description: tx.description,
      financialDate: tx.financialDate,
      categoryName: categories.name,
      memberId: tx.memberId,
      transferKind: tx.transferKind,
    })
    .from(tx)
    .leftJoin(categories, eq(tx.categoryId, categories.id))
    .where(and(eq(tx.householdId, householdId), eq(tx.status, 'confirmed')))
    .orderBy(desc(tx.financialDate), desc(tx.createdAt))
    .limit(limit);
  return rows;
}

export async function topExpenses(
  db: Db,
  householdId: string,
  range: DateRange,
  limit: number,
): Promise<TransactionRow[]> {
  return db
    .select({
      id: tx.id,
      type: tx.type,
      amountCents: tx.amountCents,
      description: tx.description,
      financialDate: tx.financialDate,
      categoryName: categories.name,
      memberId: tx.memberId,
      transferKind: tx.transferKind,
    })
    .from(tx)
    .leftJoin(categories, eq(tx.categoryId, categories.id))
    .where(expenseFilter(householdId, range))
    .orderBy(desc(tx.amountCents))
    .limit(limit);
}

/** Total ainda agendado em parcelas de planos ativos: compromisso futuro, nao gasto novo. */
export async function futureInstallments(db: Db, householdId: string): Promise<Total> {
  const [row] = await db
    .select({
      totalCents: sql<number>`coalesce(sum(${installments.amountCents}), 0)`,
      count: countRows,
    })
    .from(installments)
    .innerJoin(installmentPlans, eq(installments.planId, installmentPlans.id))
    .where(
      and(
        eq(installmentPlans.householdId, householdId),
        eq(installmentPlans.status, 'active'),
        eq(installments.status, 'scheduled'),
      ),
    );
  return row ?? { totalCents: 0, count: 0 };
}

export interface RecurringCandidate {
  description: string;
  months: number;
  averageCents: number;
}

/** Sugere gastos repetidos em meses distintos. Apenas informa; nunca cadastra sozinho. */
export async function recurringCandidates(
  db: Db,
  householdId: string,
  range: DateRange,
): Promise<RecurringCandidate[]> {
  const rows = await db
    .select({
      description: sql<string>`lower(${tx.description})`,
      months: sql<number>`count(distinct substr(${tx.financialDate}, 1, 7))`,
      averageCents: sql<number>`cast(avg(${tx.amountCents}) as integer)`,
    })
    .from(tx)
    .where(expenseFilter(householdId, range))
    .groupBy(sql`lower(${tx.description})`)
    .having(sql`count(distinct substr(${tx.financialDate}, 1, 7)) >= 2`)
    .orderBy(desc(sql`avg(${tx.amountCents})`))
    .limit(10);
  return rows;
}

export async function findTransactionsByMessage(
  db: Db,
  householdId: string,
  chatId: string,
  messageId: number,
): Promise<{ id: string }[]> {
  return db
    .select({ id: tx.id })
    .from(tx)
    .where(
      and(
        eq(tx.householdId, householdId),
        eq(tx.sourceChatId, chatId),
        eq(tx.sourceMessageId, messageId),
        eq(tx.status, 'confirmed'),
      ),
    );
}

export async function findTransactionByRef(
  db: Db,
  householdId: string,
  reference: string | null,
  memberId: string,
) {
  const base = and(eq(tx.householdId, householdId), eq(tx.status, 'confirmed'));
  if (reference === null) {
    const rows = await db
      .select()
      .from(tx)
      .where(and(base, eq(tx.createdByMemberId, memberId)))
      .orderBy(desc(tx.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }
  const code = reference.replace(/^#/, '').toLowerCase();
  if (!/^[0-9a-f]{4,36}$/.test(code)) return null;
  const rows = await db
    .select()
    .from(tx)
    .where(and(base, sql`${tx.id} LIKE ${code + '%'}`))
    .limit(2);
  return rows.length === 1 ? rows[0]! : null;
}

export const shortId = (id: string): string => id.replaceAll('-', '').slice(0, 6);
