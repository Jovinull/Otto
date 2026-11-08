import { and, eq, gte, sql } from 'drizzle-orm';
import type { Pricing } from '../../config/env';
import type { AiUsageSample } from '../../infrastructure/ai/client';
import { aiUsage } from '../../infrastructure/database/schema';
import type { Deps } from '../context';

const DAY_MS = 86_400_000;
/** Analises custam mais: param antes, preservando verba para interpretar registros. */
const ANALYSIS_BUDGET_SHARE_PERCENT = 80;

export function estimateCostMicroUsd(usage: AiUsageSample, pricing: Pricing): number {
  const price = pricing[usage.model];
  if (!price) return 0;
  const billableInput = Math.max(usage.inputTokens - usage.cachedInputTokens, 0);
  return Math.ceil(
    billableInput * price.input +
      usage.cachedInputTokens * price.cachedInput +
      usage.outputTokens * price.output,
  );
}

export async function recordUsage(
  deps: Deps,
  householdId: string,
  memberId: string,
  usage: AiUsageSample,
  outcome: string,
): Promise<void> {
  await deps.db.insert(aiUsage).values({
    id: deps.newId(),
    householdId,
    memberId,
    model: usage.model,
    operation: usage.operation,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    estimatedCostMicroUsd: estimateCostMicroUsd(usage, deps.config.pricing),
    outcome,
    createdAt: deps.now(),
  });
}

function startOfUtcDay(now: number): number {
  return now - (now % DAY_MS);
}

function startOfUtcMonth(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function startOfNextUtcMonth(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

export interface SpendSummary {
  dayMicroUsd: number;
  monthMicroUsd: number;
}

export async function aiSpend(deps: Deps): Promise<SpendSummary> {
  const now = deps.now();
  const [row] = await deps.db
    .select({
      dayMicroUsd: sql<number>`coalesce(sum(case when ${aiUsage.createdAt} >= ${startOfUtcDay(now)} then ${aiUsage.estimatedCostMicroUsd} else 0 end), 0)`,
      monthMicroUsd: sql<number>`coalesce(sum(${aiUsage.estimatedCostMicroUsd}), 0)`,
    })
    .from(aiUsage)
    .where(gte(aiUsage.createdAt, startOfUtcMonth(now)));
  return row ?? { dayMicroUsd: 0, monthMicroUsd: 0 };
}

export type Allowance =
  { allowed: true } | { allowed: false; reason: 'daily' | 'monthly'; retryAt: number };

export async function checkInterpretAllowance(deps: Deps): Promise<Allowance> {
  const spend = await aiSpend(deps);
  const now = deps.now();
  if (spend.monthMicroUsd >= deps.config.monthlyBudgetMicroUsd) {
    return { allowed: false, reason: 'monthly', retryAt: startOfNextUtcMonth(now) + 300_000 };
  }
  if (spend.dayMicroUsd >= deps.config.dailyBudgetMicroUsd) {
    return { allowed: false, reason: 'daily', retryAt: startOfUtcDay(now) + DAY_MS + 300_000 };
  }
  return { allowed: true };
}

export async function canRunAnalysis(deps: Deps): Promise<boolean> {
  const spend = await aiSpend(deps);
  const { dailyBudgetMicroUsd, monthlyBudgetMicroUsd } = deps.config;
  return (
    spend.dayMicroUsd * 100 < dailyBudgetMicroUsd * ANALYSIS_BUDGET_SHARE_PERCENT &&
    spend.monthMicroUsd * 100 < monthlyBudgetMicroUsd * ANALYSIS_BUDGET_SHARE_PERCENT
  );
}

export async function isRateLimited(deps: Deps, memberId: string): Promise<boolean> {
  const [row] = await deps.db
    .select({ count: sql<number>`count(*)` })
    .from(aiUsage)
    .where(and(eq(aiUsage.memberId, memberId), gte(aiUsage.createdAt, deps.now() - 60_000)));
  return (row?.count ?? 0) >= deps.config.maxAiCallsPerMemberPerMinute;
}
