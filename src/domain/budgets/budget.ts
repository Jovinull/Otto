import { percentOf } from '../../shared/money';

/** Codigo interno de "ultrapassou o limite", distinto de ter atingido exatamente 100%. */
export const OVER_LIMIT_THRESHOLD = 101;

export interface BudgetStatus {
  limitCents: number;
  spentCents: number;
  remainingCents: number;
  percentUsed: number;
  isOver: boolean;
}

export function computeBudgetStatus(limitCents: number, spentCents: number): BudgetStatus {
  return {
    limitCents,
    spentCents,
    remainingCents: limitCents - spentCents,
    percentUsed: percentOf(spentCents, limitCents),
    isOver: spentCents > limitCents,
  };
}

/** Limiares atingidos pelo gasto atual, em ordem crescente, ja com o de ultrapassagem. */
export function reachedThresholds(
  limitCents: number,
  spentCents: number,
  thresholds: readonly number[],
): number[] {
  const reached = [...new Set(thresholds)]
    .filter((t) => spentCents * 100 >= t * limitCents)
    .sort((a, b) => a - b);
  if (spentCents > limitCents) reached.push(OVER_LIMIT_THRESHOLD);
  return reached;
}

/** Limiares ainda nao avisados neste periodo. */
export function newThresholds(
  limitCents: number,
  spentCents: number,
  thresholds: readonly number[],
  alreadyAlerted: readonly number[],
): number[] {
  return reachedThresholds(limitCents, spentCents, thresholds).filter(
    (t) => !alreadyAlerted.includes(t),
  );
}
