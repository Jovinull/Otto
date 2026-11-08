import type { LocalDate, Period } from '../../shared/dates';
import { addMonths, dayInPeriod, periodOf } from '../../shared/dates';

/**
 * Regra de ciclo adotada (documentada em docs/domain.md): compras feitas ate a vespera do dia
 * de fechamento entram na fatura que fecha naquele mes; compras no dia do fechamento ou depois
 * vao para a fatura seguinte. O vencimento cai no mesmo mes do fechamento se o dia de vencimento
 * for maior que o de fechamento; caso contrario, no mes seguinte.
 */
export interface CardCycle {
  /** Mes (YYYY-MM) em que a fatura fecha: identifica o ciclo. */
  closingPeriod: Period;
  closingDate: LocalDate;
  dueDate: LocalDate;
}

export interface CardDays {
  closingDay: number;
  dueDay: number;
}

export function cycleClosingIn(period: Period, days: CardDays): CardCycle {
  const duePeriod = days.dueDay > days.closingDay ? period : addMonths(period, 1);
  return {
    closingPeriod: period,
    closingDate: dayInPeriod(period, days.closingDay),
    dueDate: dayInPeriod(duePeriod, days.dueDay),
  };
}

export function cycleForPurchase(purchaseDate: LocalDate, days: CardDays): CardCycle {
  const period = periodOf(purchaseDate);
  const closesThisMonth = purchaseDate < dayInPeriod(period, days.closingDay);
  return cycleClosingIn(closesThisMonth ? period : addMonths(period, 1), days);
}

/** Ciclo da parcela de numero `sequence` (1 = primeira) de uma compra parcelada. */
export function cycleForInstallment(
  purchaseDate: LocalDate,
  sequence: number,
  days: CardDays,
): CardCycle {
  const first = cycleForPurchase(purchaseDate, days);
  return cycleClosingIn(addMonths(first.closingPeriod, sequence - 1), days);
}

export interface Charge {
  closingPeriod: Period;
  amountCents: number;
}

export interface Payment {
  date: LocalDate;
  amountCents: number;
}

export type InvoiceStatus = 'paid' | 'partial' | 'open' | 'current' | 'future';

export interface Invoice extends CardCycle {
  totalCents: number;
  paidCents: number;
  remainingCents: number;
  status: InvoiceStatus;
}

/**
 * Monta as faturas e abate os pagamentos em ordem cronologica (a mais antiga primeiro).
 * Pagamento parcial nunca quita a fatura. Pagamento a mais vira credito na fatura seguinte.
 */
export function buildInvoices(
  charges: readonly Charge[],
  payments: readonly Payment[],
  days: CardDays,
  today: LocalDate,
): { invoices: Invoice[]; creditCents: number } {
  const totals = new Map<Period, number>();
  for (const charge of charges) {
    totals.set(charge.closingPeriod, (totals.get(charge.closingPeriod) ?? 0) + charge.amountCents);
  }
  const current = cycleForPurchase(today, days).closingPeriod;
  if (!totals.has(current)) totals.set(current, 0);

  let available = payments.reduce((sum, p) => sum + p.amountCents, 0);
  const invoices = [...totals.keys()].sort().map((period) => {
    const cycle = cycleClosingIn(period, days);
    const totalCents = totals.get(period)!;
    const paidCents = Math.min(available, totalCents);
    available -= paidCents;
    const remainingCents = totalCents - paidCents;
    let status: InvoiceStatus;
    if (period > current) status = 'future';
    else if (period === current) status = 'current';
    else if (remainingCents === 0) status = 'paid';
    else status = paidCents > 0 ? 'partial' : 'open';
    return { ...cycle, totalCents, paidCents, remainingCents, status };
  });
  return { invoices, creditCents: available };
}
