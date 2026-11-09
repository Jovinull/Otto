import { beforeEach, describe, expect, it } from 'vitest';
import type { Interpretation } from '../../src/infrastructure/ai/interpretation';
import type { Harness } from '../fixtures/harness';
import { buttonData, createHarness, interpretation, item, JENNIFER_ID } from '../fixtures/harness';

let h: Harness;
const MINUTE = 60_000;

async function say(text: string, from?: string) {
  h.setNow(h.now() + MINUTE);
  await h.say(text, from === undefined ? undefined : { from });
  return h.messaging.last();
}

async function ai(
  text: string,
  intent: Interpretation['intent'],
  overrides: Partial<Interpretation> = {},
  from?: string,
) {
  h.ai.nextInterpretation = interpretation(intent, overrides);
  return say(`Otto, ${text}`, from);
}

const account = (overrides: Partial<NonNullable<Interpretation['account']>>) => ({
  name_text: null,
  kind: null,
  owner_text: null,
  opening_text: null,
  closing_day: null,
  due_day: null,
  role: null,
  ...overrides,
});

const goal = (overrides: Partial<NonNullable<Interpretation['goal']>>) => ({
  entry_text: null,
  additional_costs_text: null,
  deadline_text: null,
  planned_monthly_text: null,
  emergency_reserve_text: null,
  initial_confirmed_text: null,
  contribution_text: null,
  contribution_date_text: null,
  goal_name: null,
  target_text: null,
  account_text: null,
  source_account_text: null,
  ...overrides,
});

const query = (overrides: Partial<NonNullable<Interpretation['query']>>) => ({
  period: null,
  month_text: null,
  category_slug: null,
  person_text: null,
  account_text: null,
  ...overrides,
});

async function setupAccounts() {
  await say('/addconta corrente MercadoPago saldo=2000 padrao');
  await say('/addconta reserva Cofre saldo=0');
  await say('/addconta cartao Santander fecha=3 vence=10 padrao');
  await say('/addconta corrente Nubank saldo=750 dono=Jennifer');
  await say('/contapadrao Nubank', JENNIFER_ID);
  await say('/addconta cartao PicPay fecha=3 vence=10 dono=Jennifer');
  await say('/cartaopadrao PicPay', JENNIFER_ID);
}

beforeEach(async () => {
  h = await createHarness();
});

describe('cadastro em linguagem natural', () => {
  it('cria conta do remetente com saldo', async () => {
    await ai('tenho uma conta no Mercado Pago com R$ 2.000.', 'create_account', {
      account: account({ name_text: 'Mercado Pago', opening_text: 'R$ 2.000' }),
    });
    const [row] = await h.query<{ opening_balance_cents: number; ownership: string }>(
      'SELECT opening_balance_cents, ownership FROM financial_accounts',
    );
    expect(row).toMatchObject({ opening_balance_cents: 200000, ownership: 'member' });
  });

  it('cria conta de outra pessoa e conta do casal', async () => {
    await ai('Jennifer tem uma conta no Nubank com R$ 750.', 'create_account', {
      account: account({ name_text: 'Nubank', owner_text: 'Jennifer', opening_text: 'R$ 750' }),
    });
    await ai('temos uma conta conjunta com R$ 1.500.', 'create_account', {
      account: account({
        name_text: 'Conjunta',
        kind: 'joint',
        owner_text: 'casal',
        opening_text: 'R$ 1.500',
      }),
    });
    expect(await h.count('financial_accounts', "ownership = 'shared'")).toBe(1);
    expect(await say('/minhascontas', JENNIFER_ID)).toContain('Nubank');
  });

  it('valor que nao esta na mensagem nao vira saldo', async () => {
    const reply = await ai('tenho conta no Inter', 'create_account', {
      account: account({ name_text: 'Inter', opening_text: '9000' }),
    });
    expect(reply).toContain('Não consegui confirmar');
    expect(await h.count('financial_accounts')).toBe(0);
  });

  it('define conta e cartao padrao de cada pessoa', async () => {
    await setupAccounts();
    await say('/addconta corrente Caixa saldo=10');
    await ai('meu banco principal é Caixa.', 'set_default_account', {
      account: account({ name_text: 'Caixa' }),
    });
    expect(await say('/contapadrao')).toContain('Caixa');
    await ai('meu cartão padrão é Santander.', 'set_default_card', {
      account: account({ name_text: 'Santander' }),
    });
    expect(await say('/cartaopadrao')).toContain('Santander');
    expect(await say('/contapadrao', JENNIFER_ID)).toContain('Nubank');
  });

  it('renda configurada em linguagem natural nao registra recebimento', async () => {
    await setupAccounts();
    await ai('meu salário é R$ 4.000 e cai todo dia 5 no Mercado Pago.', 'register_commitment', {
      commitment: {
        kind: 'income',
        description: 'Salário',
        amount_text: 'R$ 4.000',
        due_day: 5,
        nth_business_day: null,
        person_text: null,
        category_slug: 'salario',
        account_text: 'MercadoPago',
        is_monthly: true,
      },
    });
    expect(await h.count('financial_transactions')).toBe(0);
    expect(await say('/compromissos')).toContain('MercadoPago');
  });

  it('renda mensal sem dia fica cadastrada sem perguntar a recorrencia', async () => {
    await ai('também recebo R$ 600 por mês de um serviço freelance.', 'register_commitment', {
      commitment: {
        kind: 'income',
        description: 'Freelance',
        amount_text: 'R$ 600',
        due_day: null,
        nth_business_day: null,
        person_text: null,
        category_slug: 'renda-extra',
        account_text: null,
        is_monthly: true,
      },
    });
    expect(await h.count('recurring_entries', "schedule_type = 'monthly_unspecified'")).toBe(1);
  });
});

describe('metas em linguagem natural', () => {
  beforeEach(setupAccounts);

  it('cria metas com valor e prazo', async () => {
    await ai('quero comprar um computador de R$ 6.000 até dezembro de 2027.', 'create_goal', {
      goal: goal({ goal_name: 'Computador', target_text: 'R$ 6.000', deadline_text: '12/2027' }),
    });
    const text = await say('/meta Computador');
    expect(text).toContain('Objetivo: R$ 6.000,00');
    expect(text).toContain('dezembro/2027');
  });

  it('meta do apartamento atualiza a existente em vez de duplicar', async () => {
    await say('/meta entrada=40000');
    await ai('quero guardar R$ 50.000 para a entrada do apartamento.', 'create_goal', {
      goal: goal({ goal_name: 'entrada do apartamento', target_text: 'R$ 50.000' }),
    });
    expect(await h.count('financial_goals')).toBe(1);
    expect(await say('/metas')).toContain('Objetivo: R$ 50.000,00');
  });

  it('guardar sem local pergunta antes de mexer em saldo', async () => {
    await say('/meta criar Viagem valor=8000');
    const reply = await ai('guardei R$ 500 para a viagem.', 'register_goal_contribution', {
      goal: goal({ goal_name: 'viagem', contribution_text: 'R$ 500' }),
    });
    expect(reply).toContain('esse dinheiro já está em alguma conta');
    expect(await h.count('goal_contributions')).toBe(0);
    await say('de MercadoPago para Cofre');
    expect(await h.count('financial_transactions', "type = 'transfer'")).toBe(1);
    expect(await say('/contas')).toContain('Cofre (Felipe): R$ 500,00');
  });

  it('colocar no cofre vindo da conta principal transfere e reserva', async () => {
    await say('/meta criar Viagem valor=8000');
    await ai(
      'coloquei R$ 500 no cofre, vindo da minha conta principal.',
      'register_goal_contribution',
      {
        goal: goal({
          goal_name: 'viagem',
          contribution_text: 'R$ 500',
          account_text: 'Cofre',
          source_account_text: 'minha conta principal',
        }),
      },
    );
    const accounts = await say('/contas');
    expect(accounts).toContain('MercadoPago (Felipe): R$ 1.500,00');
    expect(accounts).toContain('Cofre (Felipe): R$ 500,00');
    expect(accounts).toContain('Patrimônio em contas: R$ 2.750,00');
    expect(await h.count('financial_transactions', "type IN ('income','expense')")).toBe(0);
  });

  it('vincula a meta ao cofre e cria o cofre se preciso', async () => {
    await say('/meta entrada=50000 inicial=300');
    await ai('nossa meta do apartamento fica no Porquinho.', 'allocate_goal', {
      goal: goal({ goal_name: 'apartamento', account_text: 'Porquinho' }),
    });
    const [row] = await h.query<{ ownership: string; kind: string }>(
      "SELECT ownership, kind FROM financial_accounts WHERE name = 'Porquinho'",
    );
    expect(row).toMatchObject({ ownership: 'shared', kind: 'reserve' });
    expect(await say('/meta apartamento')).toContain('Porquinho R$ 300,00');
  });

  it('com cofre vinculado pergunta se o dinheiro ja estava la', async () => {
    await say('/meta criar Viagem valor=8000');
    await say('/vincular Viagem @Cofre');
    const reply = await ai('guardei R$ 100 para a viagem.', 'register_goal_contribution', {
      goal: goal({ goal_name: 'viagem', contribution_text: 'R$ 100' }),
    });
    expect(reply).toContain('a meta fica em Cofre');
    await say('MercadoPago');
    expect(await h.count('financial_transactions', "type = 'transfer'")).toBe(1);
    expect(await say('/contas')).toContain('Cofre (Felipe): R$ 100,00');
  });

  it('sem meta citada e com varias metas pergunta qual', async () => {
    await say('/meta criar Viagem valor=8000');
    await say('/meta criar Moto valor=8000');
    const reply = await ai('guardei R$ 100.', 'register_goal_contribution', {
      goal: goal({ contribution_text: 'R$ 100' }),
    });
    expect(reply).toContain('Para qual meta?');
  });

  it('retirada e consulta de onde esta o dinheiro', async () => {
    await say('/meta criar Reserva de emergencia valor=12000');
    await say('/aporte Reserva de emergencia 500 @MercadoPago existente');
    await ai('tirei R$ 200 da reserva de emergência.', 'withdraw_goal', {
      goal: goal({
        goal_name: 'reserva de emergencia',
        contribution_text: 'R$ 200',
        account_text: null,
      }),
    });
    const report = await ai('onde está o dinheiro da reserva de emergência?', 'query_goal', {
      goal: goal({ goal_name: 'reserva de emergencia' }),
    });
    expect(report).toContain('Onde está: MercadoPago R$ 300,00');
  });
});

describe('consultas e pagamentos em linguagem natural', () => {
  beforeEach(setupAccounts);

  it('reconciliacao falada segue o mesmo fluxo', async () => {
    const reply = await ai('meu MercadoPago está com R$ 1.830 agora.', 'report_balance', {
      account: account({ name_text: 'MercadoPago', opening_text: 'R$ 1.830' }),
    });
    expect(reply).toContain('Não sei a causa');
    expect(await h.count('balance_reconciliations', "status = 'pending'")).toBe(1);
  });

  it('status pessoal, do casal e livre em conta', async () => {
    expect(await ai('qual é minha situação?', 'query_status_personal')).toContain(
      'Status de Felipe',
    );
    expect(await ai('qual é a nossa situação financeira hoje?', 'query_status_couple')).toContain(
      'Status do casal',
    );
    const free = await ai('quanto do meu MercadoPago está livre?', 'query_free_balance', {
      query: query({ account_text: 'MercadoPago' }),
    });
    expect(free).toContain('Livre de metas: R$ 2.000,00');
    expect(await ai('quanto eu ainda posso gastar este mês?', 'query_free_balance')).toContain(
      'Potencialmente livre',
    );
  });

  it('gastos filtrados por cartao de outra pessoa', async () => {
    await say('/gasto 180 roupa cartao @PicPay', JENNIFER_ID);
    await say('/gasto 40 lanche cartao @Santander');
    const text = await ai('quanto Jennifer gastou no cartão PicPay?', 'query_spending', {
      query: query({ period: 'this_month', person_text: 'Jennifer', account_text: 'PicPay' }),
    });
    expect(text).toContain('Jennifer gastou R$ 180,00 em PicPay');
  });

  it('fatura sem valor mostra o aberto e confirma com sim', async () => {
    await say('/gasto 300 sapato cartao @Santander 20/10/2026');
    const reply = await ai('a fatura do Santander foi paga.', 'register_transfer', {
      transactions: [
        item({
          kind: 'card_payment',
          amount_text: null,
          description: 'fatura',
          destination_account_text: 'Santander',
        }),
      ],
    });
    expect(reply).toContain('Santander: R$ 300,00 em aberto');
    expect(await h.count('financial_transactions', "type = 'transfer'")).toBe(0);
    const done = await say('sim');
    expect(done).toContain('Fatura de Santander quitada');
    expect(await h.count('financial_transactions', "type = 'transfer'")).toBe(1);
  });

  it('pagamento parcial informa quanto falta', async () => {
    await say('/gasto 300 sapato cartao @Santander 20/10/2026');
    const reply = await ai('paguei R$ 100 da fatura do Santander.', 'register_transfer', {
      transactions: [
        item({
          kind: 'card_payment',
          amount_text: 'R$ 100',
          description: 'fatura',
          destination_account_text: 'Santander',
        }),
      ],
    });
    expect(reply).toContain('ainda faltam R$ 200,00 em Santander');
  });

  it('pagamento vago sem fatura aberta nao registra nada', async () => {
    const reply = await ai('já paguei aquela parcela.', 'register_transfer', {
      transactions: [item({ kind: 'card_payment', amount_text: null, description: 'parcela' })],
    });
    expect(reply).toContain('não tem fatura em aberto');
    expect(await h.count('financial_transactions')).toBe(0);
  });

  it('parcela de cartao com dias nao e marcada a mao', async () => {
    await say('/gasto 300 tenis cartao @Santander 3x 20/10/2026');
    const [row] = await h.query<{ id: string }>(
      'SELECT transaction_id AS id FROM installment_plans',
    );
    const reply = await say(`/parcela_paga ${row!.id.slice(0, 6)}`);
    expect(reply).toContain('quitadas pelo pagamento das faturas');
    expect(await h.count('installments', "status = 'paid'")).toBe(0);
  });

  it('pagar a fatura atualiza as parcelas sem duplicar saida', async () => {
    await say('/gasto 300 tenis cartao @Santander 3x 20/10/2026');
    await say('/pagar_fatura 100 MercadoPago para Santander');
    const text = await say('/parcelas');
    expect(text).toContain('1 quitadas, restam R$ 200,00');
    expect(await say('/contas')).toContain('MercadoPago (Felipe): R$ 1.900,00');
  });

  it('conversa comum nao chama a IA', async () => {
    await say('bom dia amor');
    expect(h.ai.calls).toHaveLength(0);
  });

  it('confirmacao continua exigida quando o modelo tem pouca certeza', async () => {
    h.ai.nextInterpretation = interpretation('register_expense', {
      confidence: 'low',
      transactions: [item({ amount_text: '50', description: 'mercado' })],
    });
    await say('acho que gastei 50');
    expect(await h.count('financial_transactions')).toBe(0);
    h.setNow(h.now() + MINUTE);
    await h.press(buttonData(h.messaging, 'c'));
    expect(await h.count('financial_transactions')).toBe(1);
  });
});
