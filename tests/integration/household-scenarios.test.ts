import { beforeEach, describe, expect, it } from 'vitest';
import { runHourly } from '../../src/application/jobs/scheduled';
import type { Harness } from '../fixtures/harness';
import { buttonData, createHarness, JENNIFER_ID } from '../fixtures/harness';

/** Cenario completo do casal, com contas, cartoes e metas de cada um. */
let h: Harness;
const MINUTE = 60_000;

async function say(text: string, from?: string) {
  h.setNow(h.now() + MINUTE);
  await h.say(text, from === undefined ? undefined : { from });
  return h.messaging.last();
}
const jennifer = (text: string) => say(text, JENNIFER_ID);

async function confirm() {
  h.setNow(h.now() + MINUTE);
  await h.press(buttonData(h.messaging, 'c'));
  return h.messaging.last();
}

const count = (table: string, where?: string) => h.count(table, where);

async function sourceOfLast() {
  const [row] = await h.query<{ name: string }>(
    `SELECT a.name FROM financial_transactions t
     JOIN financial_accounts a ON a.id = t.source_account_id
     ORDER BY t.created_at DESC LIMIT 1`,
  );
  return row!.name;
}

async function ownerOfLastSource() {
  const [row] = await h.query<{ name: string }>(
    `SELECT m.name FROM financial_transactions t
     JOIN financial_accounts a ON a.id = t.source_account_id
     JOIN household_members m ON m.id = a.owner_member_id
     ORDER BY t.created_at DESC LIMIT 1`,
  );
  return row!.name;
}

beforeEach(async () => {
  h = await createHarness();
  for (const command of [
    '/addconta corrente Mercado Pago saldo=4000 padrao',
    '/addconta corrente Nubank saldo=800',
    '/addconta corrente Caixa saldo=500',
    '/addconta cartao Mercado Pago fecha=3 vence=10 padrao',
    '/addconta cartao Santander fecha=20 vence=28',
    '/addconta reserva Cofre Mercado Pago saldo=0',
    '/meta entrada=50000',
    '/meta criar Viagem valor=8000',
    '/meta criar Reserva de emergencia valor=12000',
  ]) {
    await say(command);
  }
  for (const command of [
    '/addconta corrente Nubank saldo=750 padrao',
    '/addconta corrente PicPay saldo=200',
    '/addconta cartao PicPay fecha=5 vence=12 padrao',
    '/addconta cartao Nubank fecha=6 vence=13',
  ]) {
    await jennifer(command);
  }
});

describe('contas e cartoes do casal', () => {
  it('1. varias contas por pessoa', async () => {
    const felipe = await say('/minhascontas');
    expect(felipe).toContain('Mercado Pago');
    expect(felipe).toContain('Caixa');
    expect(felipe).not.toContain('PicPay');
    expect(await jennifer('/minhascontas')).toContain('PicPay');
  });

  it('2. varios cartoes por pessoa', async () => {
    const cards = await say('/minhascontas');
    expect(cards).toContain('Mercado Pago ⭐');
    expect(cards).toContain('Santander');
    expect(await jennifer('/minhascontas')).toContain('PicPay ⭐');
  });

  it('3. conta padrao de cada pessoa', async () => {
    await say('/gasto 10 padaria pix');
    expect(await sourceOfLast()).toBe('Mercado Pago');
    await jennifer('/gasto 11 farmacia pix');
    expect(await sourceOfLast()).toBe('Nubank');
    expect(await ownerOfLastSource()).toBe('Jennifer');
  });

  it('4. cartao padrao de cada pessoa', async () => {
    await say('/gasto 90 tenis cartao');
    expect(await sourceOfLast()).toBe('Mercado Pago');
    await jennifer('/gasto 91 blusa cartao');
    expect(await sourceOfLast()).toBe('PicPay');
  });

  it('5. cartao citado vence o padrao', async () => {
    await say('/gasto 90 tenis cartao @Santander');
    expect(await sourceOfLast()).toBe('Santander');
  });

  it('6. credito a vista e uma unica parcela na fatura', async () => {
    await say('/gasto 90 tenis cartao @Santander');
    expect(await count('financial_transactions')).toBe(1);
    expect(await count('installment_plans')).toBe(0);
    expect(await say('/fatura Santander')).toContain('R$ 90,00');
  });

  it('7. parcelamento com divisao exata em centavos', async () => {
    await say('/gasto 100 tenis cartao 3x @Santander');
    const rows = await h.query<{ amount_cents: number }>('SELECT amount_cents FROM installments');
    expect(rows.map((r) => r.amount_cents).sort((a, b) => b - a)).toEqual([3334, 3333, 3333]);
  });

  it('8. pagamento parcial de fatura', async () => {
    await say('/gasto 300 tenis cartao @Santander 02/11/2026');
    const reply = await say('/pagar_fatura 100 Mercado Pago para Santander');
    expect(reply).toContain('ainda faltam R$ 200,00');
  });

  it('9. pagamento total nao duplica consumo', async () => {
    await say('/gasto 300 tenis cartao @Santander 02/11/2026');
    const reply = await say('/pagar_fatura 300 Mercado Pago para Santander');
    expect(reply).toContain('quitada');
    expect(await say('/resumo')).toContain('Saiu: R$ 300,00');
    expect(await count('financial_transactions', "type = 'expense'")).toBe(1);
  });

  it('10. pagamento vindo de outra instituicao', async () => {
    await say('/gasto 300 tenis cartao @Santander 02/11/2026');
    await say('/pagar_fatura 300 Caixa para Santander');
    expect(await say('/contas')).toContain('Caixa (Felipe): R$ 200,00');
  });

  it('11. transferencia entre bancos preserva o total', async () => {
    const before = await say('/minhascontas');
    await say('/transferir 300 Nubank para Caixa');
    const after = await say('/minhascontas');
    expect(before).toContain('Total: R$ 5.300,00');
    expect(after).toContain('Total: R$ 5.300,00');
    expect(after).toContain('Caixa: R$ 800,00');
  });
});

describe('metas e reservas do casal', () => {
  it('12. transferencia para o cofre', async () => {
    await say('/aporte Apartamento 500 @Cofre de:Mercado_Pago');
    const text = await say('/contas');
    expect(text).toContain('Cofre Mercado Pago (Felipe): R$ 500,00');
    expect(await count('financial_transactions', "type IN ('income','expense')")).toBe(0);
  });

  it('13. associar dinheiro existente a meta nao move saldo', async () => {
    await say('/meta editar Viagem aporte=100');
    await say('/aporte Viagem 1000 @Mercado_Pago existente');
    const text = await say('/contas');
    expect(text).toContain('Mercado Pago (Felipe): R$ 4.000,00 · reservado R$ 1.000,00');
    expect(await say('/meta Viagem')).toContain('Realizado neste mês: R$ 0,00');
  });

  it('14. aporte efetivo conta no mes', async () => {
    await say('/meta editar Viagem aporte=300');
    await say('/aporte Viagem 300 @Mercado_Pago');
    expect(await say('/meta Viagem')).toContain('Realizado neste mês: R$ 300,00');
  });

  it('15. retirada da meta', async () => {
    await say('/aporte Viagem 500 @Mercado_Pago existente');
    await say('/retirada Viagem 200 @Mercado_Pago');
    expect(await say('/meta Viagem')).toContain('Reservado: R$ 300,00');
  });

  it('16. reserva dividida entre contas', async () => {
    await say('/aporte Apartamento 400 @Mercado_Pago existente');
    await say('/aporte Apartamento 300 @Nubank existente');
    const text = await say('/meta Apartamento');
    expect(text).toContain('Mercado Pago R$ 400,00');
    expect(text).toContain('Nubank R$ 300,00');
    expect(text).toContain('Reservado: R$ 700,00');
  });

  it('17. varias metas na mesma conta sem duplicar', async () => {
    await say('/aporte Apartamento 300 @Caixa existente');
    await say('/aporte Viagem 200 @Caixa existente');
    expect(await say('/aporte Reserva de emergencia 100 @Caixa existente')).toContain(
      'não dá para reservar',
    );
    expect(await say('/contas')).toContain('reservado R$ 500,00 · livre R$ 0,00');
    expect(await count('goal_contributions')).toBe(2);
  });
});

describe('renda, status e saldos', () => {
  beforeEach(async () => {
    await say('/renda 4000 dia=5 @Mercado_Pago');
    await jennifer('/renda 2500 dia=10 @Nubank');
  });

  it('18. recebimento do salario', async () => {
    await say('/recebi');
    expect(await say('/contas')).toContain('Mercado Pago (Felipe): R$ 8.000,00');
    expect(await count('financial_transactions', "type = 'income'")).toBe(1);
  });

  it('19. recebimento parcial', async () => {
    expect(await say('/recebi salario 2000')).toContain('Ainda não marquei');
    expect(await count('recurring_settlements')).toBe(0);
  });

  it('20. renda extraordinaria nao quita o salario', async () => {
    await say('/receita 900 bonus');
    expect(await count('recurring_settlements')).toBe(0);
    expect(await say('/compromissos')).toContain('⏳ a receber');
  });

  it('21. status pessoal', async () => {
    const text = await jennifer('/statuspessoal');
    expect(text).toContain('Status de Jennifer');
    expect(text).toContain('Renda prevista R$ 2.500,00');
    expect(text).toContain('Nubank: R$ 750,00');
    expect(text).not.toContain('Caixa');
  });

  it('22. status do casal', async () => {
    const text = await say('/statuscasal');
    expect(text).toContain('Patrimônio em contas: R$ 6.250,00');
    expect(text).toContain('Felipe: renda prevista R$ 4.000,00');
    expect(text).toContain('Jennifer: renda prevista R$ 2.500,00');
  });

  it('23. saldo informado igual ao calculado', async () => {
    expect(await say('/saldo Caixa 500')).toContain('bate');
  });

  it('24. reconciliacao divergente', async () => {
    const reply = await say('/saldo Caixa 450');
    expect(reply).toContain('calculei R$ 500,00');
    expect(reply).toContain('informou R$ 450,00');
    await confirm();
    expect(await say('/contas')).toContain('Caixa (Felipe): R$ 450,00');
    expect(await count('financial_transactions')).toBe(0);
  });
});

describe('alertas e confiabilidade', () => {
  it('25. alerta de gastos no orcamento', async () => {
    await say('/orcamento delivery 100');
    expect(await say('/gasto 90 ifood')).toContain('90%');
  });

  it('26. alerta de vencimento', async () => {
    await say('/gasto 300 tenis cartao @Santander 25/10/2026');
    h.messaging.sent = [];
    const instant = Date.UTC(2026, 10, 25, 12);
    h.setNow(instant);
    await runHourly(h.fresh(), instant);
    expect(h.messaging.texts().join('\n')).toContain('Fatura Santander: R$ 300,00');
  });

  it('27. alerta de meta', async () => {
    await say('/meta editar Viagem aporte=300');
    h.messaging.sent = [];
    const instant = Date.UTC(2026, 10, 25, 12);
    h.setNow(instant);
    await runHourly(h.fresh(), instant);
    expect(h.messaging.texts().join('\n')).toContain('Viagem: R$ 0,00 de R$ 300,00');
  });

  it('28. reprocessar a mesma mensagem nao duplica', async () => {
    const options = { updateId: 880001, messageId: 880001 };
    await h.say('/aporte Viagem 100 @Caixa existente', options);
    await h.say('/aporte Viagem 100 @Caixa existente', options);
    expect(await count('goal_contributions')).toBe(1);
  });

  it('29. entregas concorrentes da mesma mensagem registram uma vez', async () => {
    const options = { updateId: 880002, messageId: 880002 };
    await Promise.all([
      h.say('/aporte Viagem 100 @Cofre de:Caixa', options),
      h.say('/aporte Viagem 100 @Cofre de:Caixa', options),
    ]);
    expect(await count('goal_contributions')).toBe(1);
    expect(await count('financial_transactions', "type = 'transfer'")).toBe(1);
  });

  it('30. dados atuais continuam validos depois das migracoes', async () => {
    const columns = await h.query<{ name: string }>("PRAGMA table_info('financial_goals')");
    expect(columns.map((c) => c.name)).toContain('linked_account_id');
    const report = await say('/metas');
    expect(report).toContain('Apartamento');
    expect(report).toContain('Viagem');
  });
});
