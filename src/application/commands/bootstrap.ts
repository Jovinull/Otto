import { eq, inArray } from 'drizzle-orm';
import * as z from 'zod';
import { DEFAULT_CATEGORIES } from '../../domain/finance/categories';
import type { Stmt } from '../../infrastructure/database/client';
import { commitAtomically } from '../../infrastructure/database/client';
import * as schema from '../../infrastructure/database/schema';
import { toLocalDate } from '../../shared/dates';
import type { Deps } from '../context';

const TelegramId = z.string().regex(/^-?\d{1,20}$/);

export const BootstrapInput = z.strictObject({
  householdName: z.string().trim().min(1).max(80),
  timezone: z.string().default('America/Maceio'),
  telegramChatId: TelegramId,
  members: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(40),
        telegramUserId: TelegramId,
        role: z.enum(['admin', 'member', 'viewer']).default('admin'),
      }),
    )
    .min(1)
    .max(6),
});
export type BootstrapInput = z.infer<typeof BootstrapInput>;

export type BootstrapResult =
  | { status: 'created'; householdId: string }
  | { status: 'already_bootstrapped' }
  | { status: 'invalid_timezone' };

function isValidTimezone(timeZone: string): boolean {
  try {
    toLocalDate(0, timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Cria o Household. So funciona uma vez: nao ha como tomar posse de um Otto ja configurado. */
export async function bootstrapHousehold(
  deps: Deps,
  input: BootstrapInput,
): Promise<BootstrapResult> {
  if (!isValidTimezone(input.timezone)) return { status: 'invalid_timezone' };
  const existing = await deps.db
    .select({ id: schema.households.id })
    .from(schema.households)
    .limit(1);
  if (existing.length > 0) return { status: 'already_bootstrapped' };

  const householdId = deps.newId();
  const now = deps.now();
  const statements: Stmt[] = [
    deps.db.insert(schema.households).values({
      id: householdId,
      name: input.householdName,
      timezone: input.timezone,
      telegramChatId: input.telegramChatId,
      createdAt: now,
    }),
    ...input.members.map((member) =>
      deps.db.insert(schema.householdMembers).values({
        id: deps.newId(),
        householdId,
        name: member.name,
        telegramUserId: member.telegramUserId,
        role: member.role,
        createdAt: now,
      }),
    ),
    ...DEFAULT_CATEGORIES.map((category) =>
      deps.db.insert(schema.categories).values({
        id: deps.newId(),
        householdId,
        ...category,
        createdAt: now,
      }),
    ),
  ];
  await commitAtomically(deps.db, statements);
  return { status: 'created', householdId };
}

const EXPORT_TABLES = {
  households: schema.households,
  household_members: schema.householdMembers,
  financial_accounts: schema.financialAccounts,
  categories: schema.categories,
  financial_transactions: schema.financialTransactions,
  installment_plans: schema.installmentPlans,
  budgets: schema.budgets,
  financial_goals: schema.financialGoals,
  goal_contributions: schema.goalContributions,
  recurring_entries: schema.recurringEntries,
  audit_events: schema.auditEvents,
} as const;

/** Exporta todos os dados financeiros do Household como JSON. */
export async function exportHousehold(deps: Deps, householdId: string) {
  const [
    households,
    members,
    accounts,
    categories,
    transactions,
    plans,
    budgets,
    goals,
    contributions,
    recurring,
    audit,
  ] = await deps.db.batch([
    deps.db.select().from(EXPORT_TABLES.households).where(eq(schema.households.id, householdId)),
    deps.db
      .select()
      .from(EXPORT_TABLES.household_members)
      .where(eq(schema.householdMembers.householdId, householdId)),
    deps.db
      .select()
      .from(EXPORT_TABLES.financial_accounts)
      .where(eq(schema.financialAccounts.householdId, householdId)),
    deps.db
      .select()
      .from(EXPORT_TABLES.categories)
      .where(eq(schema.categories.householdId, householdId)),
    deps.db
      .select()
      .from(EXPORT_TABLES.financial_transactions)
      .where(eq(schema.financialTransactions.householdId, householdId)),
    deps.db
      .select()
      .from(EXPORT_TABLES.installment_plans)
      .where(eq(schema.installmentPlans.householdId, householdId)),
    deps.db.select().from(EXPORT_TABLES.budgets).where(eq(schema.budgets.householdId, householdId)),
    deps.db
      .select()
      .from(EXPORT_TABLES.financial_goals)
      .where(eq(schema.financialGoals.householdId, householdId)),
    deps.db
      .select()
      .from(EXPORT_TABLES.goal_contributions)
      .where(eq(schema.goalContributions.householdId, householdId)),
    deps.db
      .select()
      .from(EXPORT_TABLES.recurring_entries)
      .where(eq(schema.recurringEntries.householdId, householdId)),
    deps.db
      .select()
      .from(EXPORT_TABLES.audit_events)
      .where(eq(schema.auditEvents.householdId, householdId)),
  ]);
  return {
    exportedAt: new Date(deps.now()).toISOString(),
    households,
    household_members: members,
    financial_accounts: accounts,
    categories,
    financial_transactions: transactions,
    installment_plans: plans,
    budgets,
    financial_goals: goals,
    goal_contributions: contributions,
    recurring_entries: recurring,
    audit_events: audit,
  };
}

/** Exclusao definitiva. Exige o nome exato do Household no corpo, alem do token de administracao. */
export async function eraseHousehold(deps: Deps, householdId: string): Promise<void> {
  const { db } = deps;
  const budgetRows = await db
    .select({ id: schema.budgets.id })
    .from(schema.budgets)
    .where(eq(schema.budgets.householdId, householdId));
  const planRows = await db
    .select({ id: schema.installmentPlans.id })
    .from(schema.installmentPlans)
    .where(eq(schema.installmentPlans.householdId, householdId));
  const recurringRows = await db
    .select({ id: schema.recurringEntries.id })
    .from(schema.recurringEntries)
    .where(eq(schema.recurringEntries.householdId, householdId));
  const budgetIds = budgetRows.map((r) => r.id);
  const planIds = planRows.map((r) => r.id);
  const recurringIds = recurringRows.map((r) => r.id);
  const statements: Stmt[] = [
    ...(budgetIds.length
      ? [db.delete(schema.budgetAlerts).where(inArray(schema.budgetAlerts.budgetId, budgetIds))]
      : []),
    ...(planIds.length
      ? [db.delete(schema.installments).where(inArray(schema.installments.planId, planIds))]
      : []),
    ...(recurringIds.length
      ? [
          db
            .delete(schema.recurringSettlements)
            .where(inArray(schema.recurringSettlements.entryId, recurringIds)),
        ]
      : []),
    db.delete(schema.installmentPlans).where(eq(schema.installmentPlans.householdId, householdId)),
    db
      .delete(schema.goalContributions)
      .where(eq(schema.goalContributions.householdId, householdId)),
    db.delete(schema.financialGoals).where(eq(schema.financialGoals.householdId, householdId)),
    db.delete(schema.budgets).where(eq(schema.budgets.householdId, householdId)),
    db.delete(schema.recurringEntries).where(eq(schema.recurringEntries.householdId, householdId)),
    db
      .delete(schema.financialTransactions)
      .where(eq(schema.financialTransactions.householdId, householdId)),
    db.delete(schema.pendingActions).where(eq(schema.pendingActions.householdId, householdId)),
    db
      .delete(schema.onboardingSessions)
      .where(eq(schema.onboardingSessions.householdId, householdId)),
    db.delete(schema.auditEvents).where(eq(schema.auditEvents.householdId, householdId)),
    db.delete(schema.aiUsage).where(eq(schema.aiUsage.householdId, householdId)),
    db.delete(schema.incomingEvents).where(eq(schema.incomingEvents.householdId, householdId)),
    db.delete(schema.outgoingMessages).where(eq(schema.outgoingMessages.householdId, householdId)),
    db
      .delete(schema.financialAccounts)
      .where(eq(schema.financialAccounts.householdId, householdId)),
    db.delete(schema.categories).where(eq(schema.categories.householdId, householdId)),
    db.delete(schema.householdMembers).where(eq(schema.householdMembers.householdId, householdId)),
    db.delete(schema.households).where(eq(schema.households.id, householdId)),
  ];
  await commitAtomically(db, statements);
}
