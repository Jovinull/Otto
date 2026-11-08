import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const id = () => text('id').primaryKey();
const createdAt = () => integer('created_at').notNull();

export const households = sqliteTable('households', {
  id: id(),
  name: text('name').notNull(),
  currency: text('currency').notNull().default('BRL'),
  timezone: text('timezone').notNull().default('America/Maceio'),
  telegramChatId: text('telegram_chat_id').notNull().unique(),
  settings: text('settings').notNull().default('{}'),
  createdAt: createdAt(),
});

export const householdMembers = sqliteTable(
  'household_members',
  {
    id: id(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id),
    name: text('name').notNull(),
    telegramUserId: text('telegram_user_id').notNull(),
    role: text('role', { enum: ['admin', 'member', 'viewer'] }).notNull(),
    status: text('status', { enum: ['active', 'revoked'] })
      .notNull()
      .default('active'),
    preferences: text('preferences').notNull().default('{}'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('member_household_telegram_uq').on(t.householdId, t.telegramUserId)],
);

export const financialAccounts = sqliteTable(
  'financial_accounts',
  {
    id: id(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    kind: text('kind', {
      enum: ['checking', 'savings', 'cash', 'reserve', 'joint', 'credit_card'],
    }).notNull(),
    ownerMemberId: text('owner_member_id').references(() => householdMembers.id),
    // Nulo significa saldo inicial desconhecido: o saldo real nao pode ser afirmado.
    openingBalanceCents: integer('opening_balance_cents'),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    creditClosingDay: integer('credit_closing_day'),
    creditDueDay: integer('credit_due_day'),
    archivedAt: integer('archived_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('account_household_name_uq').on(t.householdId, t.normalizedName)],
);

export const categories = sqliteTable(
  'categories',
  {
    id: id(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['expense', 'income'] }).notNull(),
    nature: text('nature', { enum: ['essential', 'discretionary', 'other'] }).notNull(),
    archivedAt: integer('archived_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('category_household_slug_uq').on(t.householdId, t.slug)],
);

export const financialTransactions = sqliteTable(
  'financial_transactions',
  {
    id: id(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id),
    type: text('type', { enum: ['expense', 'income', 'transfer'] }).notNull(),
    transferKind: text('transfer_kind', { enum: ['internal', 'card_payment'] }),
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull().default('BRL'),
    description: text('description').notNull(),
    categoryId: text('category_id').references(() => categories.id),
    sourceAccountId: text('source_account_id').references(() => financialAccounts.id),
    destinationAccountId: text('destination_account_id').references(() => financialAccounts.id),
    memberId: text('member_id')
      .notNull()
      .references(() => householdMembers.id),
    isShared: integer('is_shared', { mode: 'boolean' }).notNull().default(false),
    createdByMemberId: text('created_by_member_id')
      .notNull()
      .references(() => householdMembers.id),
    // Data financeira (competencia) no fuso do Household, YYYY-MM-DD.
    financialDate: text('financial_date').notNull(),
    origin: text('origin', { enum: ['command', 'natural_language', 'confirmation'] }).notNull(),
    sourceChatId: text('source_chat_id'),
    sourceMessageId: integer('source_message_id'),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    status: text('status', { enum: ['confirmed', 'voided'] })
      .notNull()
      .default('confirmed'),
    voidedAt: integer('voided_at'),
    voidedByMemberId: text('voided_by_member_id').references(() => householdMembers.id),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('tx_household_date_idx').on(t.householdId, t.status, t.financialDate),
    index('tx_household_message_idx').on(t.householdId, t.sourceChatId, t.sourceMessageId),
    check('tx_amount_positive', sql`${t.amountCents} > 0`),
    check(
      'tx_shape',
      sql`(${t.type} = 'transfer' AND ${t.sourceAccountId} IS NOT NULL AND ${t.destinationAccountId} IS NOT NULL AND ${t.sourceAccountId} <> ${t.destinationAccountId} AND ${t.transferKind} IS NOT NULL AND ${t.categoryId} IS NULL)
       OR (${t.type} = 'expense' AND ${t.destinationAccountId} IS NULL AND ${t.transferKind} IS NULL)
       OR (${t.type} = 'income' AND ${t.sourceAccountId} IS NULL AND ${t.transferKind} IS NULL)`,
    ),
  ],
);

export const installmentPlans = sqliteTable('installment_plans', {
  id: id(),
  householdId: text('household_id')
    .notNull()
    .references(() => households.id),
  transactionId: text('transaction_id')
    .notNull()
    .unique()
    .references(() => financialTransactions.id),
  totalCents: integer('total_cents').notNull(),
  installmentCount: integer('installment_count').notNull(),
  // Nunca inferida: fica nula ate o casal informar o primeiro vencimento.
  firstDueDate: text('first_due_date'),
  status: text('status', { enum: ['active', 'cancelled'] })
    .notNull()
    .default('active'),
  createdAt: createdAt(),
});

export const installments = sqliteTable(
  'installments',
  {
    id: id(),
    planId: text('plan_id')
      .notNull()
      .references(() => installmentPlans.id),
    sequence: integer('sequence').notNull(),
    amountCents: integer('amount_cents').notNull(),
    dueDate: text('due_date'),
    status: text('status', { enum: ['scheduled', 'paid'] })
      .notNull()
      .default('scheduled'),
    paidAt: integer('paid_at'),
  },
  (t) => [uniqueIndex('installment_plan_seq_uq').on(t.planId, t.sequence)],
);

export const budgets = sqliteTable(
  'budgets',
  {
    id: id(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id),
    categoryId: text('category_id').references(() => categories.id),
    memberId: text('member_id').references(() => householdMembers.id),
    // Identifica categoria + pessoa; NULL nao colide em indice unico do SQLite.
    scopeKey: text('scope_key').notNull(),
    limitCents: integer('limit_cents').notNull(),
    archivedAt: integer('archived_at'),
    createdAt: createdAt(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('budget_active_scope_uq')
      .on(t.householdId, t.scopeKey)
      .where(sql`${t.archivedAt} IS NULL`),
    check('budget_limit_positive', sql`${t.limitCents} > 0`),
  ],
);

export const budgetAlerts = sqliteTable(
  'budget_alerts',
  {
    id: id(),
    budgetId: text('budget_id')
      .notNull()
      .references(() => budgets.id),
    period: text('period').notNull(),
    threshold: integer('threshold').notNull(),
    spentCents: integer('spent_cents').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('budget_alert_uq').on(t.budgetId, t.period, t.threshold)],
);

export const financialGoals = sqliteTable(
  'financial_goals',
  {
    id: id(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['apartment', 'general'] }).notNull(),
    // Todos opcionais: a meta nasce sem valores inventados.
    entryCents: integer('entry_cents'),
    additionalCostsCents: integer('additional_costs_cents'),
    deadline: text('deadline'),
    plannedMonthlyCents: integer('planned_monthly_cents'),
    emergencyReserveCents: integer('emergency_reserve_cents'),
    notes: text('notes'),
    status: text('status', { enum: ['active', 'archived'] })
      .notNull()
      .default('active'),
    createdAt: createdAt(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('goal_household_name_uq').on(t.householdId, t.name)],
);

export const goalContributions = sqliteTable(
  'goal_contributions',
  {
    id: id(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id),
    goalId: text('goal_id')
      .notNull()
      .references(() => financialGoals.id),
    amountCents: integer('amount_cents').notNull(),
    direction: text('direction', { enum: ['in', 'out'] }).notNull(),
    kind: text('kind', { enum: ['initial', 'contribution'] }).notNull(),
    contributionDate: text('contribution_date').notNull(),
    memberId: text('member_id')
      .notNull()
      .references(() => householdMembers.id),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    status: text('status', { enum: ['confirmed', 'voided'] })
      .notNull()
      .default('confirmed'),
    createdAt: createdAt(),
  },
  (t) => [
    index('goal_contribution_goal_idx').on(t.goalId, t.status),
    check('goal_contribution_positive', sql`${t.amountCents} > 0`),
  ],
);

export const recurringEntries = sqliteTable(
  'recurring_entries',
  {
    id: id(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id),
    kind: text('kind', { enum: ['expense', 'income'] }).notNull(),
    description: text('description').notNull(),
    normalizedDescription: text('normalized_description').notNull(),
    categoryId: text('category_id').references(() => categories.id),
    memberId: text('member_id').references(() => householdMembers.id),
    memberKey: text('member_key').notNull(),
    amountCents: integer('amount_cents'),
    scheduleType: text('schedule_type', {
      enum: ['monthly_day', 'nth_weekday_approx', 'monthly_unspecified'],
    }).notNull(),
    scheduleValue: integer('schedule_value'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('recurring_active_name_uq')
      .on(t.householdId, t.kind, t.normalizedDescription, t.memberKey)
      .where(sql`${t.active} = 1`),
  ],
);

export const recurringSettlements = sqliteTable(
  'recurring_settlements',
  {
    id: id(),
    entryId: text('entry_id')
      .notNull()
      .references(() => recurringEntries.id),
    period: text('period').notNull(),
    transactionId: text('transaction_id').references(() => financialTransactions.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('recurring_settlement_uq').on(t.entryId, t.period)],
);

export const pendingActions = sqliteTable(
  'pending_actions',
  {
    id: id(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id),
    memberId: text('member_id')
      .notNull()
      .references(() => householdMembers.id),
    kind: text('kind').notNull(),
    payload: text('payload').notNull(),
    status: text('status', {
      enum: ['pending', 'confirmed', 'cancelled', 'expired'],
    })
      .notNull()
      .default('pending'),
    expiresAt: integer('expires_at').notNull(),
    createdAt: createdAt(),
    resolvedAt: integer('resolved_at'),
  },
  (t) => [index('pending_lookup_idx').on(t.householdId, t.status, t.memberId)],
);

export const incomingEvents = sqliteTable(
  'incoming_events',
  {
    id: id(),
    updateId: integer('update_id').notNull().unique(),
    householdId: text('household_id').references(() => households.id),
    kind: text('kind', { enum: ['message', 'edited_message', 'callback_query'] }).notNull(),
    chatId: text('chat_id').notNull(),
    senderTelegramId: text('sender_telegram_id').notNull(),
    messageId: integer('message_id'),
    messageDate: integer('message_date').notNull(),
    // Texto mantido apenas enquanto o evento nao atinge estado final.
    payload: text('payload'),
    status: text('status', {
      enum: ['received', 'processing', 'retry', 'deferred', 'processed', 'ignored', 'failed'],
    }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at').notNull(),
    leaseUntil: integer('lease_until'),
    // Identifica o dono do lease: so ele pode concluir o evento.
    leaseToken: text('lease_token'),
    lastErrorCode: text('last_error_code'),
    noticeSent: integer('notice_sent', { mode: 'boolean' }).notNull().default(false),
    receivedAt: integer('received_at').notNull(),
    processedAt: integer('processed_at'),
  },
  (t) => [
    index('event_queue_idx').on(t.status, t.nextAttemptAt),
    index('event_lane_idx').on(t.chatId, t.updateId),
    uniqueIndex('event_message_uq')
      .on(t.chatId, t.messageId)
      .where(sql`${t.kind} = 'message' AND ${t.messageId} IS NOT NULL`),
  ],
);

export const outgoingMessages = sqliteTable(
  'outgoing_messages',
  {
    id: id(),
    householdId: text('household_id').references(() => households.id),
    chatId: text('chat_id').notNull(),
    // Apagado apos o envio: texto financeiro nao fica retido no outbox.
    text: text('text'),
    replyToMessageId: integer('reply_to_message_id'),
    replyMarkup: text('reply_markup'),
    dedupKey: text('dedup_key').notNull().unique(),
    status: text('status', { enum: ['pending', 'sending', 'sent', 'failed'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at').notNull(),
    leaseUntil: integer('lease_until'),
    lastErrorCode: text('last_error_code'),
    createdAt: createdAt(),
    sentAt: integer('sent_at'),
  },
  (t) => [index('outbox_queue_idx').on(t.status, t.nextAttemptAt)],
);

export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: id(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id),
    actorMemberId: text('actor_member_id').references(() => householdMembers.id),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    before: text('before'),
    after: text('after'),
    createdAt: createdAt(),
  },
  (t) => [index('audit_entity_idx').on(t.householdId, t.entityType, t.entityId)],
);

export const aiUsage = sqliteTable(
  'ai_usage',
  {
    id: id(),
    householdId: text('household_id').references(() => households.id),
    memberId: text('member_id').references(() => householdMembers.id),
    model: text('model').notNull(),
    operation: text('operation').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    cachedInputTokens: integer('cached_input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    // Custo em milionesimos de dolar para evitar ponto flutuante.
    estimatedCostMicroUsd: integer('estimated_cost_micro_usd').notNull().default(0),
    outcome: text('outcome').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('ai_usage_created_idx').on(t.createdAt),
    index('ai_usage_member_idx').on(t.memberId, t.createdAt),
  ],
);

/**
 * Tabela que nunca aceita linhas. Inserir nela aborta a transacao do D1: e assim que um
 * processamento que perdeu o lease desiste sem gravar nada.
 */
export const leaseGuard = sqliteTable(
  'lease_guard',
  {
    eventId: text('event_id').notNull(),
    reason: text('reason').notNull(),
  },
  (t) => [check('lease_guard_owner_only', sql`${t.reason} = 'never'`)],
);
