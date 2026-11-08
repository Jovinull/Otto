import type { LocalDate, Period } from '../../shared/dates';
import { addMonths, periodOf } from '../../shared/dates';
import { percentOf } from '../../shared/money';

export interface GoalInput {
  entryCents: number | null;
  additionalCostsCents: number | null;
  deadline: LocalDate | null;
  plannedMonthlyCents: number | null;
  /** Soma apenas de contribuicoes confirmadas. Intencao de aporte nunca entra aqui. */
  confirmedCents: number;
  /** Quanto foi efetivamente aportado no mes corrente. */
  confirmedThisMonthCents: number;
}

export interface GoalProgress {
  targetCents: number | null;
  confirmedCents: number;
  remainingCents: number | null;
  percent: number | null;
  monthsToDeadline: number | null;
  requiredMonthlyCents: number | null;
  projectedCompletion: Period | null;
  plannedMonthlyCents: number | null;
  confirmedThisMonthCents: number;
}

export function goalTarget(entry: number | null, additional: number | null): number | null {
  if (entry === null && additional === null) return null;
  return (entry ?? 0) + (additional ?? 0);
}

/** Meses inteiros restantes ate o prazo, contando o mes corrente como disponivel para aporte. */
export function monthsUntil(from: LocalDate, deadline: LocalDate): number {
  const [fromYear, fromMonth] = periodOf(from).split('-').map(Number);
  const [toYear, toMonth] = periodOf(deadline).split('-').map(Number);
  return (toYear! - fromYear!) * 12 + (toMonth! - fromMonth!) + 1;
}

/** Projecoes ignoram rentabilidade. Os textos ao usuario precisam informar isso. */
export function computeGoalProgress(input: GoalInput, today: LocalDate): GoalProgress {
  const targetCents = goalTarget(input.entryCents, input.additionalCostsCents);
  const remainingCents =
    targetCents === null ? null : Math.max(targetCents - input.confirmedCents, 0);

  const monthsToDeadline = input.deadline ? monthsUntil(today, input.deadline) : null;
  const requiredMonthlyCents =
    remainingCents !== null && monthsToDeadline !== null && monthsToDeadline > 0
      ? Math.ceil(remainingCents / monthsToDeadline)
      : null;

  let projectedCompletion: Period | null = null;
  if (remainingCents !== null && input.plannedMonthlyCents && input.plannedMonthlyCents > 0) {
    const months = Math.ceil(remainingCents / input.plannedMonthlyCents);
    projectedCompletion = addMonths(periodOf(today), Math.max(months - 1, 0));
  }

  return {
    targetCents,
    confirmedCents: input.confirmedCents,
    remainingCents,
    percent: targetCents ? Math.min(percentOf(input.confirmedCents, targetCents), 100) : null,
    monthsToDeadline,
    requiredMonthlyCents,
    projectedCompletion,
    plannedMonthlyCents: input.plannedMonthlyCents,
    confirmedThisMonthCents: input.confirmedThisMonthCents,
  };
}

/** Quanto muda o prazo se o aporte mensal mudar. */
export function monthsToReach(remainingCents: number, monthlyCents: number): number | null {
  if (monthlyCents <= 0) return null;
  return Math.ceil(remainingCents / monthlyCents);
}
