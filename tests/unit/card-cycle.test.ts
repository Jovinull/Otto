import { describe, expect, it } from 'vitest';
import {
  buildInvoices,
  cycleClosingIn,
  cycleForInstallment,
  cycleForPurchase,
} from '../../src/domain/finance/card-cycle';

const DAYS = { closingDay: 3, dueDay: 10 };

describe('ciclo da fatura', () => {
  it('compra antes do fechamento entra na fatura do mes', () => {
    expect(cycleForPurchase('2026-11-02', DAYS)).toEqual({
      closingPeriod: '2026-11',
      closingDate: '2026-11-03',
      dueDate: '2026-11-10',
    });
  });

  it('compra no dia do fechamento ou depois vai para a fatura seguinte', () => {
    expect(cycleForPurchase('2026-11-03', DAYS).closingPeriod).toBe('2026-12');
    expect(cycleForPurchase('2026-11-30', DAYS).closingPeriod).toBe('2026-12');
  });

  it('atravessa a virada do ano', () => {
    expect(cycleForPurchase('2026-12-20', DAYS)).toEqual({
      closingPeriod: '2027-01',
      closingDate: '2027-01-03',
      dueDate: '2027-01-10',
    });
  });

  it('vencimento antes do fechamento cai no mes seguinte', () => {
    expect(cycleClosingIn('2026-11', { closingDay: 25, dueDay: 5 }).dueDate).toBe('2026-12-05');
  });

  it('fechamento no dia 31 se ajusta a meses curtos', () => {
    const days = { closingDay: 31, dueDay: 8 };
    expect(cycleClosingIn('2027-02', days).closingDate).toBe('2027-02-28');
    expect(cycleForPurchase('2027-02-28', days).closingPeriod).toBe('2027-03');
  });

  it('parcelas caem em faturas consecutivas', () => {
    expect(cycleForInstallment('2026-11-05', 1, DAYS).dueDate).toBe('2026-12-10');
    expect(cycleForInstallment('2026-11-05', 3, DAYS).dueDate).toBe('2027-02-10');
  });
});

describe('montagem das faturas', () => {
  const charges = [
    { closingPeriod: '2026-10', amountCents: 20000 },
    { closingPeriod: '2026-11', amountCents: 10000 },
    { closingPeriod: '2026-12', amountCents: 15000 },
    { closingPeriod: '2027-01', amountCents: 10000 },
  ];

  it('abate pagamentos da fatura mais antiga para a mais nova', () => {
    const { invoices } = buildInvoices(
      charges,
      [{ date: '2026-10-10', amountCents: 26000 }],
      DAYS,
      '2026-11-10',
    );
    expect(invoices.map((i) => [i.closingPeriod, i.status, i.paidCents, i.remainingCents])).toEqual(
      [
        ['2026-10', 'paid', 20000, 0],
        ['2026-11', 'partial', 6000, 4000],
        ['2026-12', 'current', 0, 15000],
        ['2027-01', 'future', 0, 10000],
      ],
    );
  });

  it('pagamento parcial nunca quita a fatura', () => {
    const { invoices } = buildInvoices(
      charges.slice(0, 1),
      [{ date: 'x', amountCents: 19999 }],
      DAYS,
      '2026-11-10',
    );
    expect(invoices[0]!.status).toBe('partial');
    expect(invoices[0]!.remainingCents).toBe(1);
  });

  it('pagamento a mais vira credito', () => {
    const { creditCents } = buildInvoices(
      charges.slice(0, 1),
      [{ date: 'x', amountCents: 25000 }],
      DAYS,
      '2026-11-10',
    );
    expect(creditCents).toBe(5000);
  });

  it('sem compras ainda mostra a fatura atual zerada', () => {
    const { invoices } = buildInvoices([], [], DAYS, '2026-11-10');
    expect(invoices).toEqual([
      expect.objectContaining({ closingPeriod: '2026-12', status: 'current', totalCents: 0 }),
    ]);
  });
});
