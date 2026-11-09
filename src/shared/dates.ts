import { normalizeText } from './text';

/** Data civil no formato YYYY-MM-DD. Datas financeiras nunca carregam horario. */
export type LocalDate = string;

export interface DateRange {
  from: LocalDate;
  to: LocalDate;
}

/** Converte um instante em data civil no fuso informado. */
export function toLocalDate(instantMs: number, timeZone: string): LocalDate {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(instantMs));
}

export interface LocalClock {
  date: LocalDate;
  hour: number;
  weekday: number; // 0 = domingo
}

export function localClock(instantMs: number, timeZone: string): LocalClock {
  const date = toLocalDate(instantMs, timeZone);
  const hour =
    Number(
      new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(
        new Date(instantMs),
      ),
    ) % 24;
  return { date, hour, weekday: weekdayOf(date) };
}

function parts(date: LocalDate): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number);
  return [y!, m!, d!];
}

function utc(date: LocalDate): number {
  const [y, m, d] = parts(date);
  return Date.UTC(y, m - 1, d);
}

function fromUtc(ms: number): LocalDate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return fromUtc(utc(date)) === date;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return fromUtc(utc(date) + days * 86_400_000);
}

export function diffDays(later: LocalDate, earlier: LocalDate): number {
  return Math.round((utc(later) - utc(earlier)) / 86_400_000);
}

export function weekdayOf(date: LocalDate): number {
  return new Date(utc(date)).getUTCDay();
}

export type Period = string; // YYYY-MM

export function periodOf(date: LocalDate): Period {
  return date.slice(0, 7);
}

export function addMonths(period: Period, months: number): Period {
  const [y, m] = period.split('-').map(Number);
  const index = y! * 12 + (m! - 1) + months;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

export function daysInMonth(period: Period): number {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y!, m!, 0)).getUTCDate();
}

export function monthRange(period: Period): DateRange {
  return { from: `${period}-01`, to: `${period}-${String(daysInMonth(period)).padStart(2, '0')}` };
}

/** Semana iniciando na segunda-feira, como e usual no Brasil para semana civil de trabalho. */
export function weekRange(date: LocalDate): DateRange {
  const offset = (weekdayOf(date) + 6) % 7;
  const from = addDays(date, -offset);
  return { from, to: addDays(from, 6) };
}

/** Ajusta um dia do mes aos meses curtos: dia 31 em novembro vira 30. */
export function dayInPeriod(period: Period, day: number): LocalDate {
  const clamped = Math.min(day, daysInMonth(period));
  return `${period}-${String(clamped).padStart(2, '0')}`;
}

/** N-esimo dia de segunda a sexta. Nao considera feriados: sempre exibir como aproximado. */
export function nthWeekdayApprox(period: Period, n: number): LocalDate {
  let date = `${period}-01`;
  let count = 0;
  for (;;) {
    const weekday = weekdayOf(date);
    if (weekday !== 0 && weekday !== 6) {
      count += 1;
      if (count === n) return date;
    }
    date = addDays(date, 1);
  }
}

const MONTHS = [
  'janeiro',
  'fevereiro',
  'marco',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

export function monthName(period: Period): string {
  const [y, m] = period.split('-').map(Number);
  const name = MONTHS[m! - 1]!;
  return `${name === 'marco' ? 'março' : name}/${y}`;
}

export function formatDate(date: LocalDate): string {
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}

export function formatShortDate(date: LocalDate): string {
  const [, m, d] = date.split('-');
  return `${d}/${m}`;
}

export type DateResolution =
  | { status: 'ok'; date: LocalDate }
  | { status: 'imprecise'; range: DateRange }
  | { status: 'invalid' };

const WEEKDAYS: Record<string, number> = {
  domingo: 0,
  segunda: 1,
  'segunda-feira': 1,
  terca: 2,
  'terca-feira': 2,
  quarta: 3,
  'quarta-feira': 3,
  quinta: 4,
  'quinta-feira': 4,
  sexta: 5,
  'sexta-feira': 5,
  sabado: 6,
};

/**
 * Resolve expressoes de data em relacao a data de envio da mensagem no fuso do Household.
 * Usa a data de envio, e nao a de processamento, para retentativas nao deslocarem o lancamento.
 * Datas futuras sao recusadas: um gasto realizado nao acontece no futuro.
 */
export function resolveDateExpression(expression: string, today: LocalDate): DateResolution {
  const text = normalizeText(expression);
  const past = (date: LocalDate): DateResolution =>
    date > today ? { status: 'invalid' } : { status: 'ok', date };

  if (['', 'hoje', 'agora', 'este mes', 'esse mes', 'neste mes', 'nesse mes'].includes(text)) {
    return { status: 'ok', date: today };
  }
  if (text === 'ontem') return { status: 'ok', date: addDays(today, -1) };
  if (text === 'anteontem' || text === 'antes de ontem')
    return { status: 'ok', date: addDays(today, -2) };

  if (text === 'semana passada' || text === 'na semana passada') {
    return { status: 'imprecise', range: weekRange(addDays(today, -7)) };
  }
  if (text === 'mes passado' || text === 'no mes passado') {
    return { status: 'imprecise', range: monthRange(addMonths(periodOf(today), -1)) };
  }

  const weekdayText = text.replace(/^(na|no|nesta|neste|ultima|ultimo)\s+/, '');
  const weekday = WEEKDAYS[weekdayText];
  if (weekday !== undefined) {
    const distance = (weekdayOf(today) - weekday + 7) % 7 || 7;
    return { status: 'ok', date: addDays(today, -distance) };
  }

  let match = /^(?:dia\s+)?(\d{1,2})$/.exec(text);
  if (match) {
    const day = Number(match[1]);
    const period = periodOf(today);
    if (day < 1 || day > 31 || day > daysInMonth(period)) return { status: 'invalid' };
    const date = `${period}-${String(day).padStart(2, '0')}`;
    if (date <= today) return { status: 'ok', date };
    // "dia 28" escrito no dia 2 so pode ser o mes anterior.
    const previous = addMonths(periodOf(today), -1);
    if (day > daysInMonth(previous)) return { status: 'invalid' };
    return { status: 'ok', date: `${previous}-${String(day).padStart(2, '0')}` };
  }

  match = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?$/.exec(text);
  if (match) {
    const day = match[1]!.padStart(2, '0');
    const month = match[2]!.padStart(2, '0');
    if (match[3]) {
      const year = match[3].length === 2 ? `20${match[3]}` : match[3];
      const date = `${year}-${month}-${day}`;
      return isValidDate(date) ? past(date) : { status: 'invalid' };
    }
    const year = today.slice(0, 4);
    const date = `${year}-${month}-${day}`;
    if (!isValidDate(date)) return { status: 'invalid' };
    if (date <= today) return { status: 'ok', date };
    const lastYear = `${Number(year) - 1}-${month}-${day}`;
    return isValidDate(lastYear) ? { status: 'ok', date: lastYear } : { status: 'invalid' };
  }

  if (isValidDate(text)) return past(text);
  return { status: 'invalid' };
}

export type NamedPeriod =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'last_7_days'
  | 'this_month'
  | 'last_month'
  | 'this_year';

export function resolveNamedPeriod(period: NamedPeriod, today: LocalDate): DateRange {
  switch (period) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const date = addDays(today, -1);
      return { from: date, to: date };
    }
    case 'this_week':
      return weekRange(today);
    case 'last_week':
      return weekRange(addDays(today, -7));
    case 'last_7_days':
      return { from: addDays(today, -6), to: today };
    case 'this_month':
      return monthRange(periodOf(today));
    case 'last_month':
      return monthRange(addMonths(periodOf(today), -1));
    case 'this_year':
      return { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` };
  }
}

export const NAMED_PERIOD_LABEL: Record<NamedPeriod, string> = {
  today: 'hoje',
  yesterday: 'ontem',
  this_week: 'esta semana',
  last_week: 'semana passada',
  last_7_days: 'nos últimos 7 dias',
  this_month: 'este mês',
  last_month: 'mês passado',
  this_year: 'este ano',
};

/** Aceita MM/AAAA ou nome do mes e devolve o periodo YYYY-MM. */
export function parseMonthExpression(expression: string, today: LocalDate): Period | null {
  const text = normalizeText(expression);
  const numeric = /^(\d{1,2})[/-](\d{4})$/.exec(text);
  if (numeric) {
    const month = Number(numeric[1]);
    if (month < 1 || month > 12) return null;
    return `${numeric[2]}-${String(month).padStart(2, '0')}`;
  }
  const iso = /^(\d{4})-(\d{2})$/.exec(text);
  if (iso && Number(iso[2]) >= 1 && Number(iso[2]) <= 12) return text;
  const named = /^(?:em\s+|de\s+)?([a-z]+)(?:\s+(?:de\s+)?(\d{4}))?$/.exec(text);
  if (!named) return null;
  const index = MONTHS.indexOf(named[1]!);
  if (index < 0) return null;
  const year = named[2] ?? today.slice(0, 4);
  return `${year}-${String(index + 1).padStart(2, '0')}`;
}
