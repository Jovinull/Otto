import * as z from 'zod';

export const INTENTS = [
  'register_expense',
  'register_income',
  'register_transfer',
  'register_goal_contribution',
  'register_commitment',
  'query_balance',
  'query_spending',
  'query_budget',
  'query_goal',
  'query_bills',
  'query_income_forecast',
  'query_cashflow',
  'query_top_expenses',
  'set_budget',
  'set_goal',
  'correct_transaction',
  'confirm_action',
  'cancel_action',
  'consult_purchase',
  'request_analysis',
  'not_financial',
  'unknown',
] as const;

const nullableText = z.string().max(200).nullable();

const TransactionItem = z.strictObject({
  kind: z.enum(['expense', 'income', 'transfer', 'card_payment']),
  amount_text: nullableText,
  description: z.string().max(120),
  category_slug: nullableText,
  person_text: nullableText,
  is_shared: z.boolean(),
  source_account_text: nullableText,
  destination_account_text: nullableText,
  date_text: nullableText,
  payment_method: z.enum(['credit', 'debit', 'pix', 'cash', 'unknown']),
  installments: z.number().int().nullable(),
});

const Query = z.strictObject({
  period: z
    .enum([
      'today',
      'yesterday',
      'this_week',
      'last_week',
      'last_7_days',
      'this_month',
      'last_month',
      'this_year',
    ])
    .nullable(),
  month_text: nullableText,
  category_slug: nullableText,
  person_text: nullableText,
});

const Budget = z.strictObject({
  category_slug: nullableText,
  amount_text: nullableText,
  person_text: nullableText,
});

const Goal = z.strictObject({
  entry_text: nullableText,
  additional_costs_text: nullableText,
  deadline_text: nullableText,
  planned_monthly_text: nullableText,
  emergency_reserve_text: nullableText,
  initial_confirmed_text: nullableText,
  contribution_text: nullableText,
  contribution_date_text: nullableText,
});

const Commitment = z.strictObject({
  kind: z.enum(['expense', 'income']),
  description: z.string().max(120),
  amount_text: nullableText,
  due_day: z.number().int().nullable(),
  nth_business_day: z.number().int().nullable(),
  person_text: nullableText,
  category_slug: nullableText,
});

const Correction = z.strictObject({
  transaction_ref: nullableText,
  field: z.enum(['amount', 'category', 'date', 'void']),
  value_text: nullableText,
});

const Purchase = z.strictObject({
  amount_text: nullableText,
  description: z.string().max(120),
  category_slug: nullableText,
});

export const Interpretation = z.strictObject({
  intent: z.enum(INTENTS),
  confidence: z.enum(['high', 'medium', 'low']),
  transactions: z.array(TransactionItem).max(10),
  query: Query.nullable(),
  budget: Budget.nullable(),
  goal: Goal.nullable(),
  commitment: Commitment.nullable(),
  correction: Correction.nullable(),
  purchase: Purchase.nullable(),
});
export type Interpretation = z.infer<typeof Interpretation>;
export type TransactionItem = z.infer<typeof TransactionItem>;

let cachedSchema: Record<string, unknown> | null = null;

/** JSON Schema aceito pelo modo estrito do Structured Outputs. */
export function interpretationJsonSchema(): Record<string, unknown> {
  if (!cachedSchema) {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(Interpretation) as Record<
      string,
      unknown
    >;
    cachedSchema = schema;
  }
  return cachedSchema;
}
