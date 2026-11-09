import { beforeEach, describe, expect, it } from 'vitest';
import type { Harness } from '../fixtures/harness';
import { buttonData, createHarness, interpretation, JENNIFER_ID } from '../fixtures/harness';

let h: Harness;
const MINUTE = 60_000;

async function say(text: string, from?: string) {
  h.setNow(h.now() + MINUTE);
  await h.say(text, from === undefined ? undefined : { from });
  return h.messaging.last();
}

async function confirm() {
  h.setNow(h.now() + MINUTE);
  await h.press(buttonData(h.messaging, 'c'));
  return h.messaging.last();
}

const incomes = () => h.count('financial_transactions', "type = 'income'");

beforeEach(async () => {
  h = await createHarness();
  await say('/addconta corrente MercadoPago saldo=1000 padrao');
  await say('/addconta corrente Nubank saldo=200');
  await say('/addconta corrente Nubank saldo=500 dono=Jennifer');
  await say('/contapadrao Nubank', JENNIFER_ID);
});

describe('fontes de renda', () => {
  it('configurar nao registra recebimento', async () => {
    await say('/renda 4000 dia=5 @MercadoPago');
    expect(await incomes()).toBe(0);
    const report = await say('/compromissos');
    expect(report).toContain('Salário (Felipe): R$ 4.000,00');
    expect(report).toContain('MercadoPago');
    expect(report).toContain('a receber');
  });

  it('recebimento usa valor e conta previstos e nao duplica', async () => {
    await say('/renda 4000 dia=5 @MercadoPago');
    expect(await say('/recebi')).toContain('R$ 4.000,00');
    expect(await incomes()).toBe(1);
    expect(await say('/contas')).toContain('MercadoPago (Felipe): R$ 5.000,00');
    expect(await say('/recebi')).toContain('já está marcado como recebido');
    expect(await incomes()).toBe(1);
    expect(await say('/compromissos')).toContain('✅ recebido');
  });

  it('recebimento parcial nao quita e o resto usa o que falta', async () => {
    await say('/renda 4000 dia=5 @MercadoPago');
    expect(await say('/recebi salario 2000')).toContain('Ainda não marquei');
    expect(await say('/compromissos')).toContain('a receber');
    // Mesmo valor minutos depois parece reenvio: o Otto confere antes de registrar.
    expect(await say('/recebi salario')).toContain('Parece repetido');
    await confirm();
    expect(await say('/compromissos')).toContain('✅ recebido');
    expect(await incomes()).toBe(2);
  });

  it('varias fontes exigem saber qual', async () => {
    await say('/renda 4000 dia=5 @MercadoPago');
    await say('/renda 600 nome=Freelance irregular');
    expect(await say('/recebi')).toContain('Qual renda?');
    expect(await incomes()).toBe(0);
    await say('/recebi freelance 350');
    expect(await incomes()).toBe(1);
  });

  it('renda irregular fica fora da previsao mensal', async () => {
    await say('/renda 4000 dia=5');
    await say('/renda 600 nome=Freelance irregular');
    expect(await say('/compromissos')).toContain('Renda prevista em novembro/2026: R$ 4.000,00');
  });

  it('conta destino respeita o dono', async () => {
    await say('/renda 2500 dia=10 @Nubank de=Jennifer');
    const [row] = await h.query<{ name: string; owner: string }>(
      `SELECT a.name AS name, m.name AS owner
       FROM recurring_entries r
       JOIN financial_accounts a ON a.id = r.account_id
       JOIN household_members m ON m.id = a.owner_member_id`,
    );
    expect(row).toMatchObject({ name: 'Nubank', owner: 'Jennifer' });
  });

  it('renda desconhecida nao vira lancamento', async () => {
    expect(await say('/recebi')).toContain('não tem renda cadastrada');
    expect(await incomes()).toBe(0);
  });
});

describe('status pessoal e do casal', () => {
  beforeEach(async () => {
    await say('/addconta conjunta Casa saldo=1500');
    await say('/addconta cartao Roxo fecha=3 vence=10 limite=5000 padrao');
    await say('/renda 4000 dia=5 @MercadoPago');
    await say('/renda 2500 dia=10 @Nubank de=Jennifer');
    await say('/recorrente 1200 dia=20 aluguel');
    await say('/meta criar Viagem valor=8000');
    await say('/aporte Viagem 300 @MercadoPago existente');
  });

  it('pessoal mostra saldo, reserva e cartao sem chamar limite de dinheiro', async () => {
    await say('/gasto 100 sapato cartao @Roxo');
    const text = await say('/statuspessoal');
    expect(text).toContain('Status de Felipe');
    expect(text).toContain('Renda prevista R$ 4.000,00 · recebida R$ 0,00');
    expect(text).toContain('MercadoPago: R$ 1.000,00 · reservado R$ 300,00 · livre R$ 700,00');
    expect(text).toContain('Roxo ⭐');
    expect(text).toContain('limite R$ 5.000,00');
    expect(text).toContain('Potencialmente livre');
    expect(text).toContain('Conta feita');
    expect(text).not.toContain('Jennifer');
  });

  it('nao soma conta compartilhada duas vezes no casal', async () => {
    const text = await say('/statuscasal');
    expect(text).toContain('Patrimônio em contas: R$ 3.200,00');
    expect(text).toContain('Casa (casal): R$ 1.500,00');
    expect(text.match(/Casa/g)).toHaveLength(1);
    expect(text).toContain('Felipe: renda prevista R$ 4.000,00');
    expect(text).toContain('Jennifer: renda prevista R$ 2.500,00');
    expect(text).toContain('reservado R$ 300,00');
    expect(text).toContain('Contas a pagar no mês: R$ 1.200,00');
  });

  it('conta com saldo desconhecido fica fora da conta do livre', async () => {
    await say('/addconta corrente Oculta');
    const text = await say('/statuspessoal');
    expect(text).toContain('Oculta: saldo desconhecido');
    expect(text).toContain('Fora da conta, sem saldo conhecido: Oculta');
  });

  it('listas pessoais separam o que e de cada um', async () => {
    const accounts = await say('/minhascontas');
    expect(accounts).toContain('MercadoPago ⭐');
    expect(accounts).toContain('Do casal:');
    expect(await say('/minhascontas', JENNIFER_ID)).toContain('Nubank ⭐: R$ 500,00');
    expect(await say('/minhascontas')).toContain('Roxo ⭐');
    expect(await say('/minhascontas', JENNIFER_ID)).not.toContain('Roxo');
    expect(await say('/metas')).toContain('Reservado: R$ 300,00');
  });

  it('divida informada no cartao aparece na fatura', async () => {
    await say('/addconta cartao Velho fecha=3 vence=10 divida=450');
    expect(await say('/minhascontas')).toContain('Velho: a pagar R$ 450,00');
  });

  it('status de pessoa desconhecida responde sem erro', async () => {
    expect(await say('/statuspessoal Fulano')).toContain('Não encontrei');
  });
});

describe('recebimento em linguagem natural', () => {
  it('meu salario caiu usa o previsto e pede confirmacao', async () => {
    await say('/renda 4000 dia=5 @MercadoPago');
    h.ai.nextInterpretation = interpretation('register_income', {
      transactions: [
        {
          kind: 'income',
          amount_text: null,
          description: 'Salário',
          category_slug: 'salario',
          person_text: null,
          is_shared: false,
          source_account_text: null,
          destination_account_text: null,
          date_text: null,
          payment_method: 'unknown',
          installments: null,
        },
      ],
    });
    const reply = await say('meu salário caiu');
    expect(reply).toContain('Vou usar o valor previsto de Salário: R$ 4.000,00');
    expect(await incomes()).toBe(0);
    await confirm();
    expect(await incomes()).toBe(1);
    expect(await say('/contas')).toContain('MercadoPago (Felipe): R$ 5.000,00');
  });
});
