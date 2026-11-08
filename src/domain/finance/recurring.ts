import type { LocalDate, Period } from '../../shared/dates';
import { dayInPeriod, nthWeekdayApprox } from '../../shared/dates';
import { normalizeText } from '../../shared/text';

export type ScheduleType = 'monthly_day' | 'nth_weekday_approx' | 'monthly_unspecified';

export interface RecurringSchedule {
  scheduleType: ScheduleType;
  scheduleValue: number | null;
}

export interface ExpectedDate {
  date: LocalDate | null;
  /** Verdadeiro quando a data ignora feriados e calendario bancario. */
  approximate: boolean;
}

export function expectedDate(schedule: RecurringSchedule, period: Period): ExpectedDate {
  const value = schedule.scheduleValue;
  if (schedule.scheduleType === 'monthly_day' && value !== null) {
    return { date: dayInPeriod(period, value), approximate: false };
  }
  if (schedule.scheduleType === 'nth_weekday_approx' && value !== null) {
    return { date: nthWeekdayApprox(period, value), approximate: true };
  }
  return { date: null, approximate: false };
}

interface MatchableEntry {
  id: string;
  normalizedDescription: string;
  kind: 'expense' | 'income';
  memberId: string | null;
}

/**
 * Liga um lancamento efetivo a um compromisso previsto somente se houver um unico candidato cujo
 * nome aparece inteiro na descricao. O pagamento so e marcado porque o usuario relatou o pagamento.
 */
export function findRecurringMatch<T extends MatchableEntry>(
  description: string,
  kind: 'expense' | 'income',
  memberId: string,
  entries: readonly T[],
): T | null {
  const text = ` ${normalizeText(description).replace(/[^a-z0-9 ]/g, ' ')} `;
  const candidates = entries.filter(
    (entry) =>
      entry.kind === kind &&
      (entry.memberId === null || entry.memberId === memberId) &&
      text.includes(` ${entry.normalizedDescription} `),
  );
  return candidates.length === 1 ? candidates[0]! : null;
}
