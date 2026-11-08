import * as z from 'zod';

/** Segredos cadastrados via `wrangler secret put` ou `.dev.vars`; ausentes ate o deploy. */
export interface Secrets {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  ADMIN_API_TOKEN?: string;
  OPENAI_API_KEY?: string;
  /** Variaveis de deploy (nao segredos) que liberam operacoes sensiveis por HTTP. Padrao: off. */
  ADMIN_ALLOW_EXPORT?: string;
  ADMIN_ALLOW_ERASE?: string;
}

export type Bindings = Env & Secrets;

const Pricing = z.record(
  z.string(),
  z.object({
    input: z.number().nonnegative(),
    cachedInput: z.number().nonnegative(),
    output: z.number().nonnegative(),
  }),
);
export type Pricing = z.infer<typeof Pricing>;

export interface AppConfig {
  environment: string;
  telegramBotToken: string | null;
  webhookSecret: string | null;
  adminApiToken: string | null;
  /** Exportar e apagar exigem token E variavel de deploy: token vazado sozinho nao basta. */
  allowExport: boolean;
  allowErase: boolean;
  openAiApiKey: string | null;
  modelFast: string;
  modelAnalysis: string;
  dailyBudgetMicroUsd: number;
  monthlyBudgetMicroUsd: number;
  maxAiCallsPerMemberPerMinute: number;
  pricing: Pricing;
}

function microUsd(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 1_000_000) : 0;
}

function parsePricing(raw: string): Pricing {
  try {
    return Pricing.parse(JSON.parse(raw));
  } catch {
    // Sem tabela valida o custo estimado seria zero e o limite nunca dispararia.
    throw new Error('OPENAI_PRICING_JSON invalido');
  }
}

export function loadConfig(env: Bindings): AppConfig {
  return {
    environment: env.APP_ENV,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || null,
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || null,
    adminApiToken: env.ADMIN_API_TOKEN || null,
    allowExport: env.ADMIN_ALLOW_EXPORT === 'true',
    allowErase: env.ADMIN_ALLOW_ERASE === 'true',
    openAiApiKey: env.OPENAI_API_KEY || null,
    modelFast: env.OPENAI_MODEL_FAST,
    modelAnalysis: env.OPENAI_MODEL_ANALYSIS,
    dailyBudgetMicroUsd: microUsd(env.OPENAI_DAILY_BUDGET_USD),
    monthlyBudgetMicroUsd: microUsd(env.OPENAI_MONTHLY_BUDGET_USD),
    maxAiCallsPerMemberPerMinute: Number(env.AI_MAX_CALLS_PER_MEMBER_PER_MINUTE) || 10,
    pricing: parsePricing(env.OPENAI_PRICING_JSON),
  };
}
