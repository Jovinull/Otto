import { monthsToReach } from '../../domain/goals/goal';
import type { Tone } from '../../domain/household/settings';
import type { LocalDate } from '../../shared/dates';
import { addMonths, monthRange, periodOf } from '../../shared/dates';
import { logEvent } from '../../shared/errors';
import { formatBRL, parseBRL, percentOf } from '../../shared/money';
import type { Category, Deps, Scope } from '../context';
import {
  accountBalances,
  cashFlow,
  expensesByCategory,
  loadBudgetViews,
  loadGoals,
  recurringCandidates,
  sumExpenses,
} from '../queries/finance';
import { commitmentLoad, compareMonths, monthReport } from '../queries/reports';
import { canRunAnalysis, recordUsage } from './ai-governor';

export interface PurchaseQuestion {
  amountCents: number;
  description: string;
  category: Category | null;
}

/** Margem so existe quando ha renda prevista completa; caso contrario seria invencao. */
function estimateMargin(input: {
  incomeKnown: boolean;
  expectedIncomeCents: number;
  spentCents: number;
  openBillsCents: number;
  plannedGoalCents: number;
}): number | null {
  if (!input.incomeKnown) return null;
  return (
    input.expectedIncomeCents - input.spentCents - input.openBillsCents - input.plannedGoalCents
  );
}

/** Recomendacao deterministica: toda afirmacao sai de numeros calculados pelo backend. */
export async function consultPurchase(
  deps: Deps,
  scope: Scope,
  today: LocalDate,
  question: PurchaseQuestion,
): Promise<string> {
  const period = periodOf(today);
  const range = monthRange(period);
  const value = formatBRL(question.amountCents);
  const tone: Tone = scope.settings.tone;
  const [views, spent, load, goals] = await Promise.all([
    loadBudgetViews(deps.db, scope, period),
    sumExpenses(deps.db, scope.household.id, range),
    commitmentLoad(deps, scope, period),
    loadGoals(deps.db, scope.household.id, today),
  ]);
  const plannedRemaining = goals.reduce(
    (sum, g) =>
      sum + Math.max((g.progress.plannedMonthlyCents ?? 0) - g.progress.confirmedThisMonthCents, 0),
    0,
  );
  const margin = estimateMargin({
    incomeKnown: load.incomeKnown,
    expectedIncomeCents: load.expectedIncomeCents,
    spentCents: spent.totalCents,
    openBillsCents: load.openBillsCents,
    plannedGoalCents: plannedRemaining,
  });

  const budget = question.category
    ? views.find((v) => v.categoryId === question.category!.id && v.memberId === null)
    : undefined;
  const lines: string[] = [];

  if (budget) {
    const after = budget.status.remainingCents - question.amountCents;
    if (after >= 0) {
      lines.push(
        tone === 'neutral'
          ? `${value} cabe no orçamento de ${budget.categoryName}: restariam ${formatBRL(after)}.`
          : `Cabe! ${value} em ${budget.categoryName} ainda deixa ${formatBRL(after)} no orçamento do mês. ${percentOf(budget.status.spentCents + question.amountCents, budget.status.limitCents) >= 80 ? 'Só que fica apertado até o fim do mês.' : 'Pode aproveitar sem culpa.'}`,
      );
    } else {
      lines.push(
        `${value} passa o orçamento de ${budget.categoryName} em ${formatBRL(-after)} (restam ${formatBRL(Math.max(budget.status.remainingCents, 0))}).`,
      );
    }
  } else {
    lines.push(
      question.category
        ? `${question.category.name} não tem limite definido, então olho o mês como um todo.`
        : 'Não identifiquei a categoria, então olho o mês como um todo.',
    );
  }

  if (margin === null) {
    lines.push('Não sei dizer a folga real: falta cadastrar a renda prevista completa (/renda).');
  } else {
    const afterMargin = margin - question.amountCents;
    lines.push(
      `Folga estimada do mês depois disso: ${formatBRL(afterMargin)} (renda prevista ${formatBRL(load.expectedIncomeCents)}, gasto ${formatBRL(spent.totalCents)}, contas em aberto ${formatBRL(load.openBillsCents)}${plannedRemaining > 0 ? `, aporte pretendido restante ${formatBRL(plannedRemaining)}` : ''}). É estimativa, não saldo.`,
    );
    if (afterMargin < 0) {
      lines.push(
        tone === 'firm'
          ? 'Eu não faria agora: compromete o que já está previsto.'
          : 'Eu seguraria dessa vez ou reduziria o valor; do jeito que está, aperta o que já está previsto.',
      );
    } else if (!budget) {
      lines.push(
        tone === 'firm' ? 'Dá, com moderação.' : 'Pelos números, dá para fazer. Bom proveito. 🍕',
      );
    }
  }
  return lines.join('\n');
}

export interface AnalysisFacts {
  facts: Record<string, unknown>;
  allowedAmounts: Set<number>;
  allowedPercents: Set<number>;
  fallback: string;
}

/** Monta os fatos enviados ao modelo: somente agregados, sem descricoes de lancamentos. */
export async function buildAnalysisFacts(
  deps: Deps,
  scope: Scope,
  today: LocalDate,
): Promise<AnalysisFacts> {
  const period = periodOf(today);
  const range = monthRange(period);
  const householdId = scope.household.id;
  const [flow, categories, budgets, goals, load, comparison, balances, candidates] =
    await Promise.all([
      cashFlow(deps.db, householdId, range),
      expensesByCategory(deps.db, householdId, range),
      loadBudgetViews(deps.db, scope, period),
      loadGoals(deps.db, householdId, today),
      commitmentLoad(deps, scope, period),
      compareMonths(deps, scope, period, today),
      accountBalances(deps.db, scope),
      recurringCandidates(deps.db, householdId, {
        from: monthRange(addMonths(period, -2)).from,
        to: range.to,
      }),
    ]);

  const allowedAmounts = new Set<number>();
  const allowedPercents = new Set<number>();
  const money = (cents: number): string => {
    allowedAmounts.add(Math.abs(cents));
    return formatBRL(cents);
  };
  const percent = (value: number): string => {
    allowedPercents.add(Math.abs(value));
    return `${value}%`;
  };

  const discretionary = categories.filter((c) => c.nature === 'discretionary');
  const totalExpense = flow.expenseCents;
  const goal = goals.find((g) => g.kind === 'apartment');
  let goalFacts: Record<string, unknown> | null = null;
  if (goal) {
    const remaining = goal.progress.remainingCents;
    const planned = goal.progress.plannedMonthlyCents;
    const scenario =
      remaining !== null && planned !== null && planned > 0
        ? {
            aporte_pretendido: money(planned),
            meses_no_ritmo_pretendido: monthsToReach(remaining, planned),
            aporte_com_20_porcento_a_mais: money(Math.ceil((planned * 120) / 100)),
            meses_com_20_porcento_a_mais: monthsToReach(
              remaining,
              Math.ceil((planned * 120) / 100),
            ),
          }
        : null;
    goalFacts = {
      confirmado: money(goal.progress.confirmedCents),
      alvo: goal.progress.targetCents === null ? null : money(goal.progress.targetCents),
      falta: remaining === null ? null : money(remaining),
      progresso: goal.progress.percent === null ? null : percent(goal.progress.percent),
      aporte_necessario_mensal:
        goal.progress.requiredMonthlyCents === null
          ? null
          : money(goal.progress.requiredMonthlyCents),
      realizado_no_mes: money(goal.progress.confirmedThisMonthCents),
      cenario: scenario,
      observacao: 'projeções ignoram rendimentos',
    };
  }

  const otherGoals = goals
    .filter((g) => g.kind !== 'apartment')
    .map((g) => ({
      nome: g.name,
      reservado: money(g.progress.confirmedCents),
      alvo: g.progress.targetCents === null ? null : money(g.progress.targetCents),
      realizado_no_mes: money(g.progress.confirmedThisMonthCents),
    }));

  const facts: Record<string, unknown> = {
    outras_metas: otherGoals,
    periodo: period,
    entradas: money(flow.incomeCents),
    despesas: money(flow.expenseCents),
    resultado: money(flow.incomeCents - flow.expenseCents),
    por_categoria: categories.slice(0, 10).map((c) => ({
      categoria: c.name,
      tipo: c.nature,
      total: money(c.totalCents),
      participacao: percent(percentOf(c.totalCents, totalExpense)),
    })),
    variacao_vs_mes_anterior_mesmo_intervalo: comparison.items.slice(0, 6).map((item) => ({
      categoria: item.name,
      atual: money(item.currentCents),
      anterior: money(item.previousCents),
      variacao: percent(item.changePercent),
    })),
    orcamentos: budgets.map((b) => ({
      categoria: b.categoryName,
      limite: money(b.status.limitCents),
      gasto: money(b.status.spentCents),
      restante: money(b.status.remainingCents),
      uso: percent(b.status.percentUsed),
    })),
    renda_prevista: load.incomeKnown
      ? money(load.expectedIncomeCents)
      : 'não cadastrada por completo',
    contas_em_aberto: money(load.openBillsCents),
    comprometimento_essencial_da_renda:
      load.incomeKnown && load.expectedIncomeCents > 0
        ? percent(percentOf(load.committedExpenseCents, load.expectedIncomeCents))
        : null,
    parcelas_futuras: money(load.futureInstallmentsCents),
    categorias_com_margem_de_ajuste: discretionary.slice(0, 3).map((c) => c.name),
    possiveis_recorrencias_nao_cadastradas: candidates.slice(0, 5).map((c) => ({
      meses: c.months,
      media: money(c.averageCents),
    })),
    saldos_inicial_informado: balances.every((b) => b.balanceCents !== null),
    meta_apartamento: goalFacts,
  };
  return {
    facts,
    allowedAmounts,
    allowedPercents,
    fallback: await monthReport(deps, scope, period),
  };
}

/** Confere cada valor citado no texto gerado contra os fatos calculados pelo backend. */
export function isGrounded(
  text: string,
  allowedAmounts: ReadonlySet<number>,
  allowedPercents: ReadonlySet<number>,
): boolean {
  const amounts = text.match(/R\$\s*-?\d[\d.,]*/g) ?? [];
  for (const raw of amounts) {
    const parsed = parseBRL(raw.replace(/^R\$\s*-?/, '').replace(/[.,]$/, ''));
    if (parsed.status !== 'ok' || !allowedAmounts.has(parsed.cents)) return false;
  }
  const percents = text.match(/-?\d+(?:,\d+)?\s*%/g) ?? [];
  for (const raw of percents) {
    const value = Number(raw.replace('%', '').replace(',', '.').replace('-', '').trim());
    if (!allowedPercents.has(value)) return false;
  }
  return true;
}

const FALLBACK_PREFIX = 'Vou de números puros desta vez, sem análise elaborada:\n';

export async function analysisAnswer(
  deps: Deps,
  scope: Scope,
  memberId: string,
  today: LocalDate,
  question: string,
): Promise<string> {
  const analysis = await buildAnalysisFacts(deps, scope, today);
  if (!deps.ai || !(await canRunAnalysis(deps))) return FALLBACK_PREFIX + analysis.fallback;

  let answer: string | null = null;
  try {
    const result = await deps.ai.writeAnalysis(analysis.facts, question);
    const grounded =
      result.ok && isGrounded(result.value, analysis.allowedAmounts, analysis.allowedPercents);
    await recordUsage(
      deps,
      scope.household.id,
      memberId,
      result.usage,
      grounded ? 'ok' : 'rejected',
    );
    if (result.ok && grounded) answer = result.value;
    if (result.ok && !grounded) logEvent('warn', 'analysis_not_grounded');
  } catch (error) {
    logEvent('warn', 'analysis_failed', { name: error instanceof Error ? error.name : 'unknown' });
  }
  return answer ?? FALLBACK_PREFIX + analysis.fallback;
}
