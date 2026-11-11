import { beforeEach, describe, expect, it } from 'vitest';
import { exportHousehold } from '../../src/application/commands/bootstrap';
import { commandsText } from '../../src/application/services/help';
import { runHourly } from '../../src/application/jobs/scheduled';
import { SUBREQUEST_LIMIT } from '../../src/infrastructure/database/metered';
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

async function confirm() {
  h.setNow(h.now() + MINUTE);
  await h.press(buttonData(h.messaging, 'c'));
  return h.messaging.last();
}

async function ai(text: string, value: Interpretation, from?: string) {
  h.ai.nextInterpretation = value;
  return say(text, from);
}

const accountAi = (overrides: Partial<NonNullable<Interpretation['account']>>) => ({
  name_text: null,
  kind: null,
  owner_text: null,
  opening_text: null,
  closing_day: null,
  due_day: null,
  role: null,
  ...overrides,
});

beforeEach(async () => {
  h = await createHarness();
});

describe('nomes de conta com espaco', () => {
  beforeEach(async () => {
    await say('/addconta corrente Mercado Pago saldo=1000 padrao');
    await say('/addconta reserva Cofre Mercado Pago saldo=0');
    await say('/meta criar Viagem valor=8000');
  });

  it('gasto, aporte e renda aceitam o nome como foi cadastrado', async () => {
    await say('/gasto 10 pao @Mercado Pago');
    const [row] = await h.query<{ description: string }>(
      'SELECT description FROM financial_transactions',
    );
    expect(row!.description).toBe('pao');
    expect(await say('/aporte Viagem 100 @Cofre Mercado Pago de:Mercado Pago')).toContain(
      'Aporte confirmado',
    );
    await say('/renda 4000 dia=5 @Mercado Pago');
    expect(await say('/compromissos')).toContain('· Mercado Pago ·');
  });

  it('"saldo 1500" sem igual vira saldo, nao parte do nome', async () => {
    await say('/addconta corrente PicPay saldo 1500 padrao');
    await say('/addconta cartao Santander fecha 3 vence: 10 limite R$ 5000');
    await say('/editconta Mercado Pago saldo: 1200');
    const rows = await h.query<{ name: string; opening: number | null; closing: number | null }>(
      `SELECT name, opening_balance_cents AS opening, credit_closing_day AS closing
       FROM financial_accounts ORDER BY name`,
    );
    expect(rows.map((r) => r.name)).toEqual([
      'Cofre Mercado Pago',
      'Mercado Pago',
      'PicPay',
      'Santander',
    ]);
    expect(rows.find((r) => r.name === 'PicPay')!.opening).toBe(150000);
    expect(rows.find((r) => r.name === 'Mercado Pago')!.opening).toBe(120000);
    expect(rows.find((r) => r.name === 'Santander')!.closing).toBe(3);
  });

  it('conta criada com o saldo no nome se ajeita com /editconta', async () => {
    // Como ficou em producao antes da correcao.
    await h.query(
      `UPDATE financial_accounts SET name = 'Mercado Pago saldo 1500',
       normalized_name = 'mercado pago saldo 1500', opening_balance_cents = NULL,
       opening_balance_date = NULL WHERE name = 'Mercado Pago'`,
    );
    await h.query(
      "UPDATE financial_accounts SET name = 'Cofre', normalized_name = 'cofre' WHERE kind = 'reserve'",
    );
    expect(await say('/editconta Mercado Pago nome=Mercado_Pago saldo=1500')).toContain(
      'saldo inicial',
    );
    expect(await say('/contas')).toContain('Mercado Pago (Felipe): R$ 1.500,00');
  });

  it('nome escrito junto acha a conta', async () => {
    await say('/gasto 10 pao @MercadoPago');
    expect(await h.count('financial_transactions')).toBe(1);
    expect(h.messaging.last()).not.toContain('Não achei');
  });

  it('nome de outra conta nao cai no cofre existente', async () => {
    await say('/addconta reserva Cofre saldo=0');
    await say('/vincular Viagem @Porquinho Novo');
    const [row] = await h.query<{ kind: string }>(
      "SELECT kind FROM financial_accounts WHERE name = 'Porquinho Novo'",
    );
    expect(row?.kind).toBe('reserve');
  });
});

describe('entradas invalidas nao gravam nada', () => {
  beforeEach(async () => {
    await say('/addconta corrente Principal saldo=1000 padrao');
    await say('/meta criar Viagem valor=8000');
  });

  const invalid = [
    '/aporte',
    '/aporte Viagem',
    '/aporte Viagem abc',
    '/aporte Viagem 0',
    '/aporte Viagem -50',
    '/aporte Inexistente 100 @Principal',
    '/aporte Viagem 100 @Inexistente',
    '/aporte Viagem 100 @Principal de:Principal',
    '/retirada Viagem 100',
    '/meta criar',
    '/meta criar Viagem2 valor=abc',
    '/meta criar Viagem3 prazo=99/2027',
    '/meta editar Nada valor=1',
    '/meta remover Nada',
    '/vincular Viagem',
    '/saldo Principal',
    '/saldo Principal abc',
    '/saldo Nada 10',
    '/recebi',
    '/renda abc dia=5',
    '/renda 100 dia=99',
    '/renda 100 dia=5 @Nada',
    '/renda 100 dia=5 de=Fulano',
    '/recorrente',
    '/recorrente abc dia=5 aluguel',
    '/contapadrao Nada',
    '/cartaopadrao Nada',
    '/notificacoes contas dias=99',
    '/notificacoes semanal dia=xyz',
    '/notificacoes meta dia=31',
    '/notificacoes orcamento avisos=abc',
    '/mes',
    '/padrao',
    '/alocar Viagem 10 @Principal',
    '/individual',
    '/rendas',
    '/livre Principal',
  ];

  it.each(invalid)('%s', async (command) => {
    const contributions = await h.count('goal_contributions');
    const transactions = await h.count('financial_transactions');
    const incomes = await h.count('recurring_entries');
    const reply = await say(command);
    expect(reply.length).toBeGreaterThan(0);
    expect(reply).not.toContain('undefined');
    expect(reply).not.toContain('[object');
    expect(await h.count('goal_contributions')).toBe(contributions);
    expect(await h.count('financial_transactions')).toBe(transactions);
    expect(await h.count('recurring_entries')).toBe(incomes);
  });

  it('nome de meta enorme e recusado', async () => {
    expect(await say(`/meta criar ${'a'.repeat(80)} valor=10`)).toContain('muito longo');
  });

  it('perfil somente leitura nao altera metas nem saldos', async () => {
    await h.query(
      "UPDATE household_members SET role = 'viewer' WHERE telegram_user_id = ?",
      JENNIFER_ID,
    );
    for (const command of [
      '/aporte Viagem 10 @Principal',
      '/retirada Viagem 10',
      '/vincular Viagem @Principal',
      '/saldo Principal 10',
      '/recebi',
      '/meta remover Viagem',
    ]) {
      expect(await say(command, JENNIFER_ID)).toContain('somente leitura');
    }
    expect(await h.count('goal_contributions')).toBe(0);
  });
});

describe('metas: regras finas', () => {
  beforeEach(async () => {
    await say('/addconta corrente Principal saldo=3000 padrao');
    await say('/addconta reserva Cofre saldo=0');
  });

  it('nome com numero nao confunde o valor', async () => {
    await say('/meta criar Viagem 2027 valor=8000');
    await say('/aporte Viagem 2027 500 @Principal');
    expect(await say('/meta Viagem 2027')).toContain('Reservado: R$ 500,00');
  });

  it('valor em formato R$ funciona', async () => {
    await say('/meta criar Viagem valor=8000');
    await say('/aporte Viagem R$ 500 @Principal');
    expect(await h.count('goal_contributions', 'amount_cents = 50000')).toBe(1);
  });

  it('/meta NOME campo=valor edita em vez de ignorar', async () => {
    await say('/meta criar Viagem valor=8000');
    await say('/meta Viagem valor=9000');
    expect(await say('/meta Viagem')).toContain('Objetivo: R$ 9.000,00');
  });

  it('"Apartamento da praia" e uma meta comum', async () => {
    await say('/meta entrada=50000');
    await say('/meta criar Apartamento da praia valor=9000');
    expect(await h.count('financial_goals')).toBe(2);
    expect(await h.count('financial_goals', "kind = 'apartment'")).toBe(1);
  });

  it('dinheiro existente nao conta como aporte do mes', async () => {
    await say('/meta criar Viagem valor=8000 aporte=100');
    await say('/aporte Viagem 500 @Principal existente');
    expect(await say('/meta Viagem')).toContain('Realizado neste mês: R$ 0,00');
    expect(await h.count('goal_contributions', "kind = 'allocation'")).toBe(1);
  });

  it('retirada existente nao aceita a palavra existente', async () => {
    await say('/meta criar Viagem valor=8000');
    expect(await say('/retirada Viagem 10 @Principal existente')).toContain('Formato');
  });

  it('corrigir o valor de uma transferencia de meta e recusado', async () => {
    await say('/meta criar Viagem valor=8000');
    await say('/aporte Viagem 100 @Cofre de:Principal');
    const [row] = await h.query<{ id: string }>('SELECT id FROM financial_transactions');
    expect(await say(`/corrigir ${row!.id.slice(0, 6)} valor 200`)).toContain('aporte em meta');
  });

  it('/estornar desfaz aporte pelo codigo da resposta', async () => {
    await say('/meta criar Viagem valor=8000');
    const reply = await say('/aporte Viagem 100 @Principal');
    const code = /estornar (\S+)/.exec(reply)![1]!;
    await say(`/estornar ${code}`);
    expect(await confirm()).toContain('desfeito');
    expect(await say('/meta Viagem')).toContain('Reservado: R$ 0,00');
  });

  it('mostra quem guardou quando os dois guardaram', async () => {
    await say('/meta criar Viagem valor=8000');
    await say('/aporte Viagem 100 @Principal');
    await say('/aporte Viagem 200 @Cofre de:Principal', JENNIFER_ID);
    const text = await say('/meta Viagem');
    expect(text).toContain('Quem guardou:');
    expect(text).toContain('Felipe R$ 100,00');
    expect(text).toContain('Jennifer R$ 200,00');
  });

  it('saldo aprovado abaixo do reservado avisa antes', async () => {
    await say('/meta criar Viagem valor=8000');
    await say('/aporte Viagem 2000 @Principal existente');
    expect(await say('/saldo Principal 1000')).toContain('mais do que esse saldo');
  });
});

describe('o que o modelo real devolveu', () => {
  beforeEach(async () => {
    await say('/addconta corrente Mercado Pago saldo=1000 padrao');
    await say('/addconta reserva Cofre saldo=0');
    await say('/addconta cartao PicPay fecha=5 vence=12 dono=Jennifer');
    await say('/addconta corrente PicPay saldo=50 dono=Jennifer');
  });

  const commitment = (overrides: Partial<NonNullable<Interpretation['commitment']>>) => ({
    kind: 'income' as const,
    description: 'salário',
    amount_text: '4.000',
    due_day: 5,
    nth_business_day: null,
    person_text: null,
    category_slug: 'salario',
    account_text: 'Mercado Pago',
    is_monthly: true,
    ...overrides,
  });

  it('"Otto, meu salario" nao trata Otto como pessoa', async () => {
    await ai(
      'Otto, meu salário é R$ 4.000 e cai todo dia 5 no Mercado Pago.',
      interpretation('register_commitment', { commitment: commitment({ person_text: 'Otto' }) }),
    );
    expect(await h.count('recurring_entries')).toBe(1);
    expect(await say('/compromissos')).toContain('Salário (Felipe)');
  });

  it('"PicPay e Nubank" vira duas contas', async () => {
    await ai(
      'Jennifer tem Inter e Nubank.',
      interpretation('create_account', {
        account: accountAi({ name_text: 'Inter e Nubank', owner_text: 'Jennifer' }),
      }),
    );
    expect(await h.count('financial_accounts', "name IN ('Inter', 'Nubank')")).toBe(2);
    expect(await h.count('financial_accounts', "name = 'Inter e Nubank'")).toBe(0);
  });

  it('conta conjunta sem nome ganha nome padrao', async () => {
    await ai(
      'Temos uma conta conjunta com R$ 1.500.',
      interpretation('create_account', {
        account: accountAi({ kind: 'joint', owner_text: 'casal', opening_text: '1.500' }),
      }),
    );
    expect(await h.count('financial_accounts', "name = 'Conta conjunta'")).toBe(1);
  });

  it('"em 1 vez" e credito mesmo sem dizer cartao', async () => {
    await ai(
      'Jennifer comprou R$ 180 no PicPay em 1 vez.',
      interpretation('register_expense', {
        transactions: [
          item({
            amount_text: '180',
            description: 'compra',
            person_text: 'Jennifer',
            source_account_text: 'PicPay',
            installments: 1,
          }),
        ],
      }),
    );
    const [row] = await h.query<{ kind: string }>(
      `SELECT a.kind FROM financial_transactions t JOIN financial_accounts a ON a.id = t.source_account_id`,
    );
    expect(row!.kind).toBe('credit_card');
  });

  it('"este mes" nao vira data invalida', async () => {
    await ai(
      'Este mês recebi um bônus de R$ 900.',
      interpretation('register_income', {
        transactions: [
          item({
            kind: 'income',
            amount_text: '900',
            description: 'bônus',
            date_text: 'Este mês',
          }),
        ],
      }),
    );
    expect(await h.count('financial_transactions', "type = 'income'")).toBe(1);
  });

  it('transferencia para cofre ligado a uma meta reserva para ela', async () => {
    await say('/meta criar Viagem valor=8000');
    await say('/vincular Viagem @Cofre');
    await ai(
      'Coloquei R$ 500 no cofre, vindo da minha conta principal.',
      interpretation('register_transfer', {
        transactions: [
          item({
            kind: 'transfer',
            amount_text: '500',
            description: 'cofre',
            source_account_text: 'conta principal',
            destination_account_text: 'Cofre',
          }),
        ],
      }),
    );
    expect(await say('/meta Viagem')).toContain('Reservado: R$ 500,00');
    expect(await say('/contas')).toContain('Mercado Pago (Felipe): R$ 500,00');
  });

  it('transferencia para a conta principal resolve o padrao da pessoa', async () => {
    await ai(
      'Transferi R$ 100 do cofre para a conta principal.',
      interpretation('register_transfer', {
        transactions: [
          item({
            kind: 'transfer',
            amount_text: '100',
            description: 'volta',
            source_account_text: 'Cofre',
            destination_account_text: 'conta principal',
          }),
        ],
      }),
    );
    expect(await say('/contas')).toContain('Mercado Pago (Felipe): R$ 1.100,00');
  });

  it('pergunta de saldo de uma conta responde so aquela conta', async () => {
    const text = await ai(
      'Quanto tenho guardado no Mercado Pago?',
      interpretation('query_balance', {
        query: {
          period: null,
          month_text: null,
          category_slug: null,
          person_text: null,
          account_text: 'Mercado Pago',
        },
      }),
    );
    expect(text).toContain('Mercado Pago: saldo R$ 1.000,00');
    expect(text).not.toContain('PicPay');
  });
});

describe('filtro local nao gasta IA a toa', () => {
  it.each(['me conta uma coisa', 'caiu a internet aqui', 'qual o status do pedido da pizzaria'])(
    '%s',
    async (text) => {
      await say(text);
      expect(h.ai.calls).toHaveLength(0);
    },
  );

  it.each(['Quais faturas ainda estão abertas?', 'Cria uma conta da Caixa para mim'])(
    '%s',
    async (text) => {
      await say(text);
      expect(h.ai.calls).toHaveLength(1);
    },
  );
});

describe('preferencias de frequencia', () => {
  it('mostra e altera cada frequencia', async () => {
    expect(await say('/notificacoes')).toContain('avisa 3 dias antes');
    await say('/notificacoes contas dias=5');
    await say('/notificacoes orcamento avisos=70,100');
    await say('/notificacoes semanal dia=dom');
    await say('/notificacoes meta dia=25');
    const text = await say('/notificacoes');
    expect(text).toContain('avisa 5 dias antes');
    expect(text).toContain('em 70%, 100%');
    expect(text).toContain('toda dom');
    expect(text).toContain('a partir do dia 25');
  });

  it('o dia configurado vale para o resumo semanal e para as metas', async () => {
    await say('/addconta corrente Principal saldo=1000 padrao');
    await say('/meta criar Viagem valor=8000 aporte=100');
    await say('/gasto 10 pao');
    await say('/notificacoes semanal dia=dom');
    await say('/notificacoes meta dia=25');

    const run = async (date: number) => {
      h.messaging.sent = [];
      h.setNow(date);
      await runHourly(h.fresh(), date);
      return h.messaging.texts().join('\n');
    };
    // 16/11/2026 e segunda; 15/11 e domingo.
    expect(await run(Date.UTC(2026, 10, 15, 12))).toContain('🗓️');
    expect(await run(Date.UTC(2026, 10, 16, 12))).not.toContain('Saldo divergente');
    expect(await run(Date.UTC(2026, 10, 24, 12))).not.toContain('metas do mês');
    expect(await run(Date.UTC(2026, 10, 25, 12))).toContain('metas do mês');
  });
});

describe('limites do plano gratuito', () => {
  it('pior hora da semana com muitos cartoes e metas cabe no limite', async () => {
    const at = async (iso: string, text: string) => {
      h.setNow(
        Date.UTC(
          Number(iso.slice(0, 4)),
          Number(iso.slice(5, 7)) - 1,
          Number(iso.slice(8, 10)),
          15,
        ),
      );
      await h.say(text);
    };
    await at('2026-08-01', '/addconta corrente Principal saldo=100000 padrao');
    for (const name of ['A', 'B', 'C', 'D']) {
      await at('2026-08-01', `/addconta cartao ${name} fecha=3 vence=25`);
    }
    for (const name of ['Um', 'Dois', 'Tres', 'Quatro']) {
      await at('2026-08-01', `/meta criar ${name} valor=1000 aporte=100`);
    }
    await at('2026-08-01', '/orcamento delivery 100');
    await at('2026-08-01', '/recorrente 1200 dia=25 aluguel');
    await at('2026-08-10', '/gasto 100 ifood');
    await at('2026-09-10', '/gasto 100 ifood');
    await at('2026-10-10', '/gasto 100 ifood');
    await at('2026-11-20', '/gasto 400 ifood');
    await at('2026-11-20', '/saldo Principal 1');
    // 23/11/2026: segunda-feira, depois do dia 20, com contas vencendo.
    const instant = Date.UTC(2026, 10, 23, 12);
    h.setNow(instant);
    const deps = h.fresh();
    await runHourly(deps, instant);
    expect(deps.meter.count).toBeLessThanOrEqual(SUBREQUEST_LIMIT);
  });

  it('/comandos cabe em uma mensagem do Telegram', () => {
    expect(commandsText().length).toBeLessThan(4096);
  });

  it('nenhum comando documentado foi removido do roteador', async () => {
    const documented = new Set(commandsText().match(/\/[a-z_]+/g));
    for (const command of documented) {
      const reply = await say(command);
      expect(reply, command).not.toContain('Não conheço esse comando');
    }
  });

  it('status com tudo preenchido cabe em uma mensagem e no limite', async () => {
    await say('/addconta corrente Principal saldo=1000 padrao');
    for (let i = 0; i < 8; i++) await say(`/addconta cartao Cartao${i} fecha=3 vence=10`);
    for (let i = 0; i < 12; i++) await say(`/meta criar Meta numero ${i} valor=1000`);
    const deps = h.fresh();
    h.messaging.sent = [];
    expect((await say('/statuscasal')).length).toBeLessThan(4096);
    expect(deps.meter.count).toBeLessThanOrEqual(SUBREQUEST_LIMIT);
  });
});

describe('cadastro guiado: o mesmo banco para os dois', () => {
  it('renda e padrao vao para a conta da pessoa certa', async () => {
    const answer = async (...texts: string[]) => {
      for (const text of texts) await say(text);
    };
    await answer('/configurar', 'neutro', '4000', 'dia 5', '2500', 'dia 10', 'pronto');
    await answer('corrente Nubank 100', 'corrente Caixa 10');
    await answer('corrente Nubank 200 de Jennifer', 'corrente Inter 20 de Jennifer', 'pronto');
    await answer('Nubank', 'Nubank', 'Nubank', 'Nubank');
    for (let i = 0; i < 6; i++) await say('pular');
    for (let i = 0; i < 5; i++) await say('pular');
    await answer('pular', 'pular', 'pular', '50', 'Nubank Jennifer');
    await answer('pular', 'pular', 'pronto', 'todos');
    expect(await confirm()).toContain('Configuração ativada');

    const rows = await h.query<{ owner: string; account_owner: string }>(
      `SELECT m.name AS owner, o.name AS account_owner
       FROM recurring_entries r
       JOIN household_members m ON m.id = r.member_id
       JOIN financial_accounts a ON a.id = r.account_id
       JOIN household_members o ON o.id = a.owner_member_id`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.account_owner).toBe(row.owner);

    const [goal] = await h.query<{ owner: string }>(
      `SELECT o.name AS owner FROM financial_goals g
       JOIN financial_accounts a ON a.id = g.linked_account_id
       JOIN household_members o ON o.id = a.owner_member_id`,
    );
    expect(goal!.owner).toBe('Jennifer');
  });
});

describe('exportacao', () => {
  it('inclui as reconciliacoes', async () => {
    await say('/addconta corrente Principal saldo=100 padrao');
    await say('/saldo Principal 50');
    const [house] = await h.query<{ id: string }>('SELECT id FROM households');
    const exported = JSON.stringify(await exportHousehold(h.deps, house!.id));
    expect(exported).toContain('reportedCents');
  });
});
