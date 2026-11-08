import { beforeEach, describe, expect, it } from 'vitest';
import { accountBalances } from '../../src/application/queries/finance';
import { loadScope } from '../../src/application/context';
import type { Harness } from '../fixtures/harness';
import { buttonData, createHarness, JENNIFER_ID, withAccounts } from '../fixtures/harness';

let h: Harness;
const MINUTE = 60_000;

beforeEach(async () => {
  h = await createHarness();
});

describe('previsto versus realizado', () => {
  it('recebimento parcial nao marca o salario previsto como recebido', async () => {
    await h.say('/renda 4200 util=5');
    await h.say('/receita 2100 salário');
    expect(h.messaging.last()).toContain('R$ 2.100,00 de R$ 4.200,00 previstos');
    expect(await h.count('recurring_settlements')).toBe(0);
    await h.say('/compromissos');
    expect(h.messaging.last()).toContain('a receber');

    h.setNow(h.now() + 5 * MINUTE);
    await h.say('/receita 2100 salário');
    expect(await h.count('recurring_settlements')).toBe(1);
    await h.say('/compromissos');
    expect(h.messaging.last()).toContain('✅ recebido');
  });

  it('pagamento parcial de conta fixa nao quita a conta', async () => {
    await h.say('/recorrente despesa 1200 dia=5 aluguel');
    await h.say('/gasto 600 aluguel');
    expect(await h.count('recurring_settlements')).toBe(0);
    await h.say('/compromissos');
    expect(h.messaging.last()).toContain('aluguel');
  });

  it('conta de valor variavel e quitada pelo primeiro pagamento', async () => {
    await h.say('/recorrente despesa ? dia=10 energia');
    await h.say('/gasto 187,40 energia');
    expect(await h.count('recurring_settlements')).toBe(1);
  });
});

describe('saldos sem dinheiro disponivel enganoso', () => {
  beforeEach(() => withAccounts(h));

  it('mostra divida do cartao e dinheiro separado para a meta', async () => {
    await h.say('/gasto 300 sapato cartao @Nubank');
    await h.say('/meta entrada=80000 inicial=400');
    await h.say('/contas');
    const text = h.messaging.last();
    expect(text).not.toContain('Disponível');
    expect(text).toContain('Em contas, fora reservas: R$ 1.000,00');
    expect(text).toContain('Dívida total nos cartões (inclui parcelas futuras): R$ 300,00');
    expect(text).toContain('Separado para metas (confirmado): R$ 400,00');
  });

  it('pagamento a mais no cartao aparece como credito, nao some', async () => {
    await h.say('/gasto 100 sapato cartao @Nubank');
    await h.say('/pagar_fatura 150 Principal para Nubank');
    await h.say('/contas');
    expect(h.messaging.last()).toContain('Nubank: crédito a favor R$ 50,00');
  });

  it('transferencia para a reserva lembra que nao e aporte', async () => {
    await h.say('/meta entrada=80000');
    await h.say('/transferir 300 Principal para Reserva');
    expect(h.messaging.last()).toContain('/aporte 300,00');
    expect(await h.count('goal_contributions')).toBe(0);
  });

  it('estornar pagamento de fatura devolve a divida', async () => {
    await h.say('/gasto 300 sapato cartao @Nubank');
    await h.say('/pagar_fatura 300 Principal para Nubank');
    const [payment] = await h.query<{ id: string }>(
      "SELECT id FROM financial_transactions WHERE transfer_kind = 'card_payment'",
    );
    await h.say(`/estornar ${payment!.id.replaceAll('-', '').slice(0, 6)}`);
    await h.press(buttonData(h.messaging, 'c'));
    await h.say('/contas');
    expect(h.messaging.last()).toContain('Nubank: dívida em aberto R$ 300,00');
    expect(h.messaging.last()).toContain('Principal: R$ 1.000,00');
  });

  it('parcelamento estornado deixa de ser compromisso futuro', async () => {
    await h.say('/gasto 1200 celular cartao 6x');
    const [purchase] = await h.query<{ id: string }>('SELECT id FROM financial_transactions');
    await h.say(`/estornar ${purchase!.id.replaceAll('-', '').slice(0, 6)}`);
    await h.press(buttonData(h.messaging, 'c'));
    await h.say('/parcelas');
    expect(h.messaging.last()).toContain('Nenhum parcelamento ativo');
  });

  it('invariante: contas menos divida dos cartoes = inicial + receitas - despesas', async () => {
    const operations = [
      '/receita 4200 salario',
      '/gasto 80 mercado',
      '/transferir 500 Principal para Reserva',
      '/gasto 300 sapato cartao @Nubank',
      '/gasto 1200 celular cartao 6x',
      '/pagar_fatura 450 Principal para Nubank',
      '/transferir 200 Reserva para Principal',
      '/gasto 35,90 farmacia @Reserva',
      '/receita 150 reembolso @Reserva',
    ];
    for (const [i, operation] of operations.entries()) {
      h.setNow(h.now() + (i + 1) * 3 * MINUTE);
      await h.say(operation);
    }
    const scope = (await loadScope(
      h.deps.db,
      (await h.query<{ id: string }>('SELECT id FROM households'))[0]!.id,
    ))!;
    const balances = await accountBalances(h.deps.db, scope);
    const net = balances.reduce((sum, b) => sum + (b.balanceCents ?? 0), 0);
    const [totals] = await h.query<{ income: number; expense: number }>(
      `SELECT coalesce(sum(CASE WHEN type = 'income' THEN amount_cents END), 0) AS income,
              coalesce(sum(CASE WHEN type = 'expense' THEN amount_cents END), 0) AS expense
       FROM financial_transactions WHERE status = 'confirmed'`,
    );
    const opening = 1000_00 + 500_00;
    expect(net).toBe(opening + totals!.income - totals!.expense);
    expect(totals!.expense).toBe(80_00 + 300_00 + 1200_00 + 35_90);
  });
});

describe('orcamento individual e compartilhado', () => {
  it('limite individual ignora gasto marcado como do casal', async () => {
    await h.say('/orcamento lazer 100 de=Jennifer');
    await h.say('/orcamento lazer 300');
    await h.say('/gasto 70 cinema casal', { from: JENNIFER_ID });
    await h.say('/gasto 20 cinema', { from: JENNIFER_ID });
    await h.say('/orcamento');
    const text = h.messaging.last();
    expect(text).toContain('Lazer (Jennifer): R$ 20,00 de R$ 100,00');
    expect(text).toContain('Lazer: R$ 90,00 de R$ 300,00');
  });
});

describe('lancamentos duplicados', () => {
  it('mesma compra registrada pelos dois pede confirmacao', async () => {
    await h.say('/gasto 80 mercado');
    h.setNow(h.now() + 30 * MINUTE);
    await h.say('/gasto 80 supermercado', { from: JENNIFER_ID });
    expect(await h.count('financial_transactions')).toBe(1);
    expect(h.messaging.last()).toContain('Parece repetido: Felipe já registrou R$ 80,00');
    await h.press(buttonData(h.messaging, 'c'), JENNIFER_ID);
    expect(await h.count('financial_transactions')).toBe(2);
  });

  it('reenvio imediato da mesma pessoa pede confirmacao', async () => {
    await h.say('/gasto 5 café');
    await h.say('/gasto 5 café');
    expect(await h.count('financial_transactions')).toBe(1);
    expect(h.messaging.last()).toContain('você mesmo');
  });

  it('dois gastos iguais da mesma pessoa em horarios diferentes sao normais', async () => {
    await h.say('/gasto 5 café');
    h.setNow(h.now() + 3 * 60 * MINUTE);
    await h.say('/gasto 5 café');
    expect(await h.count('financial_transactions')).toBe(2);
  });
});
