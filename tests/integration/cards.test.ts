import { beforeEach, describe, expect, it } from 'vitest';
import { runHourly } from '../../src/application/jobs/scheduled';
import type { Harness } from '../fixtures/harness';
import { createHarness } from '../fixtures/harness';

let h: Harness;
const day = (iso: string) =>
  Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)), 15);

async function at(iso: string, text: string) {
  h.setNow(day(iso));
  await h.say(text);
}

beforeEach(async () => {
  h = await createHarness();
  await at('2026-10-20', '/addconta corrente Principal saldo=5000 padrao');
  await at('2026-10-20', '/addconta cartao Nubank fecha=3 vence=10');
});

describe('faturas do cartao', () => {
  it('separa fatura fechada, atual e parcelas futuras; pagamento parcial fica parcial', async () => {
    await at('2026-11-02', '/gasto 100 mercado @Nubank');
    await at('2026-11-05', '/gasto 50 farmacia @Nubank');
    await at('2026-11-05', '/gasto 600 celular cartao 6x');
    await at('2026-11-10', '/pagar_fatura 60 Principal para Nubank');
    await at('2026-11-10', '/fatura');
    const text = h.messaging.last();
    expect(text).toContain(
      'Fatura de novembro/2026 (fechou 03/11, vence 10/11): R$ 100,00 · pago R$ 60,00, falta R$ 40,00',
    );
    expect(text).toContain('Fatura atual (fecha 03/12, vence 10/12): R$ 150,00 até agora');
    expect(text).toContain('Parcelas em faturas futuras: R$ 500,00 (5 fatura(s))');
  });

  it('pagar a fatura nao duplica despesas e quita quando cobre o total', async () => {
    await at('2026-11-02', '/gasto 100 mercado @Nubank');
    await at('2026-11-10', '/pagar_fatura 100 Principal para Nubank');
    await at('2026-11-10', '/fatura');
    expect(h.messaging.last()).toContain('R$ 100,00 · paga ✅');
    await at('2026-11-10', '/resumo');
    expect(h.messaging.last()).toContain('Saiu: R$ 100,00');
  });

  it('fatura vencida e nao paga aparece como pendencia', async () => {
    await at('2026-10-01', '/gasto 80 mercado @Nubank');
    await at('2026-11-02', '/gasto 30 padaria @Nubank');
    await at('2026-11-20', '/fatura');
    expect(h.messaging.last()).toContain('Faturas anteriores ainda em aberto: R$ 80,00');
  });

  it('parcelas recebem vencimento calculado pelos dias do cartao', async () => {
    await at('2026-11-05', '/gasto 300 fone cartao 3x');
    expect(h.messaging.last()).toContain('1ª parcela na fatura que vence 10/12');
    const dates = await h.query<{ due_date: string }>(
      'SELECT due_date FROM installments ORDER BY sequence',
    );
    // 10/01/2027 e domingo: a parcela vence na segunda.
    expect(dates.map((d) => d.due_date)).toEqual(['2026-12-10', '2027-01-11', '2027-02-10']);
  });

  it('cartao sem dias cadastrados nao inventa vencimento', async () => {
    await at('2026-11-05', '/addconta cartao Inter');
    await at('2026-11-05', '/gasto 300 fone @Inter 3x');
    expect(h.messaging.last()).toContain('Sem data de 1º vencimento');
    expect(await h.count('installments', 'due_date IS NOT NULL')).toBe(0);
    await at('2026-11-05', '/fatura inter');
    expect(h.messaging.last()).toContain('cadastre os dias');
  });

  it('juros sao lancados como encargo separado na fatura', async () => {
    await at('2026-11-05', '/gasto 12,90 juros @Nubank');
    const [row] = await h.query<{ slug: string }>(
      'SELECT c.slug FROM financial_transactions t JOIN categories c ON c.id = t.category_id',
    );
    expect(row!.slug).toBe('encargos');
    await at('2026-11-05', '/fatura');
    expect(h.messaging.last()).toContain('R$ 12,90 até agora');
  });

  it('estornar compra parcelada tira as parcelas das faturas', async () => {
    await at('2026-11-05', '/gasto 600 celular cartao 6x');
    const [purchase] = await h.query<{ id: string }>('SELECT id FROM financial_transactions');
    await at('2026-11-05', `/estornar ${purchase!.id.replaceAll('-', '').slice(0, 6)}`);
    const data = h.messaging.sent.at(-1)!.buttons![0]![0]!.data;
    await h.press(data);
    await at('2026-11-05', '/fatura');
    expect(h.messaging.last()).not.toContain('Parcelas em faturas futuras');
  });

  it('lembra o vencimento da fatura com saldo em aberto', async () => {
    await at('2026-11-02', '/gasto 100 mercado @Nubank');
    h.messaging.sent = [];
    const morning = Date.UTC(2026, 10, 7, 12, 0); // 07/11 09:00 em Maceio, vencimento em 3 dias
    h.setNow(morning);
    await runHourly(h.fresh(), morning);
    expect(h.messaging.last()).toContain('Fatura Nubank: R$ 100,00 (10/11)');
  });
});
