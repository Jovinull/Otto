import type { Interpretation } from '../../src/infrastructure/ai/interpretation';

export interface EvalCase {
  id: string;
  kind: string;
  text: string;
  setup?: string[];
  golden: Partial<Omit<Interpretation, 'transactions' | 'commitment' | 'account'>> & {
    commitment?: Omit<NonNullable<Interpretation['commitment']>, 'account_text' | 'is_monthly'> &
      Partial<NonNullable<Interpretation['commitment']>>;
    account?: Partial<NonNullable<Interpretation['account']>>;
    intent: Interpretation['intent'];
    transactions?: Partial<Interpretation['transactions'][number]>[];
  };
  expect: {
    intents: string[];
    amounts?: (number | null)[];
    kinds?: string[];
    installments?: number[];
    person?: string;
    dates?: string[];
    correctionValue?: number;
    purchaseAmount?: number;
    write: 'transaction' | 'config' | 'none';
    reply?: boolean;
    reachesModel?: boolean;
    noContribution?: boolean;
  };
}

const QUERY = {
  period: null,
  month_text: null,
  category_slug: null,
  person_text: null,
  account_text: null,
};
const GOAL = {
  entry_text: null,
  additional_costs_text: null,
  deadline_text: null,
  planned_monthly_text: null,
  emergency_reserve_text: null,
  initial_confirmed_text: null,
  contribution_text: null,
  contribution_date_text: null,
  goal_name: null,
  target_text: null,
  account_text: null,
  source_account_text: null,
};

/** Completa a interpretacao ideal com os valores nulos exigidos pelo schema estrito. */
export function toInterpretation(golden: EvalCase['golden']): Interpretation {
  return {
    intent: golden.intent,
    confidence: golden.confidence ?? 'high',
    transactions: (golden.transactions ?? []).map((t) => ({
      kind: 'expense',
      amount_text: null,
      description: '',
      category_slug: null,
      person_text: null,
      is_shared: false,
      source_account_text: null,
      destination_account_text: null,
      date_text: null,
      payment_method: 'unknown',
      installments: null,
      ...t,
    })),
    query: golden.query ? { ...QUERY, ...golden.query } : null,
    budget: golden.budget ?? null,
    goal: golden.goal ? { ...GOAL, ...golden.goal } : null,
    commitment: golden.commitment
      ? { account_text: null, is_monthly: false, ...golden.commitment }
      : null,
    correction: golden.correction ?? null,
    purchase: golden.purchase ?? null,
    invoice: golden.invoice ?? null,
    help_topic: golden.help_topic ?? null,
    account: golden.account
      ? {
          name_text: null,
          kind: null,
          owner_text: null,
          opening_text: null,
          closing_day: null,
          due_day: null,
          role: null,
          ...golden.account,
        }
      : null,
  };
}
