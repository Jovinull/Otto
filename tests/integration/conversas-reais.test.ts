import { beforeEach, describe, expect, it } from 'vitest';
import type { Harness } from '../fixtures/harness';
import { createHarness, interpretation, item, JENNIFER_ID } from '../fixtures/harness';

/**
 * Cenarios tirados da conversa real do casal no Telegram. Cada pessoa tem as suas contas e varias
 * tem o mesmo nome (Nubank, Mercado Pago), o que e esperado: o dono e quem resolve.
 */
let h: Harness;

const jennifer = (text: string) => h.say(text, { from: JENNIFER_ID });

interface Row {
  descr: string;
  cents: number;
  type: string;
  kind: string | null;
  account: string | null;
  owner: string | null;
}

async function transactions(): Promise<Row[]> {
  return h.query<Row>(
    `SELECT t.description AS descr, t.amount_cents AS cents, t.type AS type, a.kind AS kind,
            a.name AS account, m.name AS owner
       FROM financial_transactions t
       LEFT JOIN financial_accounts a ON a.id = COALESCE(t.source_account_id, t.destination_account_id)
       LEFT JOIN household_members m ON m.id = a.owner_member_id
      WHERE t.status = 'confirmed'
      ORDER BY t.created_at`,
  );
}

beforeEach(async () => {
  h = await createHarness();
  // Felipe: sem conta padrao, como o Jovino na vida real.
  await h.say('/addconta corrente Mercado Pago saldo=1500');
  await h.say('/addconta corrente Nubank saldo=600');
  await h.say('/addconta corrente Caixa saldo=700');
  await h.say('/addconta cartao Mercado Pago fecha=2 vence=8 limite=1500');
  await h.say('/addconta cartao Nubank fecha=20 vence=24 limite=4650');
  // Jennifer: mesmas instituicoes, outras contas.
  await jennifer('/addconta corrente Mercado pago saldo=1499 padrao');
  await jennifer('/addconta corrente Picpay');
  await jennifer('/addconta corrente Santander');
  await jennifer('/addconta corrente Nubank');
  await jennifer('/addconta cartao Mercado Pago fecha=10 vence=14 limite=500 padrao');
  await jennifer('/addconta cartao Picpay fecha=10 vence=15 limite=100');
});

describe('resposta a "em qual conta?" com o rotulo das opcoes', () => {
  async function askLanche() {
    h.ai.nextInterpretation = interpretation('register_expense', {
      transactions: [
        item({ amount_text: '12', description: 'lanche', source_account_text: 'Mercado Pago' }),
      ],
    });
    await jennifer('Gastei 12 lanche mercado pago');
    expect(h.messaging.last()).toContain('De qual conta saiu?');
  }

  it('"Mercado pago (Jennifer)" registra na conta corrente dela, nao no cartao', async () => {
    await askLanche();
    await jennifer('Mercado pago (Jennifer)');
    expect(await transactions()).toEqual([
      expect.objectContaining({ cents: 1200, kind: 'checking', owner: 'Jennifer' }),
    ]);
    expect(h.messaging.last()).toContain('R$ 12,00');
  });

  it('"Mercado Pago (cartão, Jennifer)" registra no cartao dela', async () => {
    await askLanche();
    await jennifer('Mercado Pago (cartão, Jennifer)');
    expect(await transactions()).toEqual([
      expect.objectContaining({ cents: 1200, kind: 'credit_card', owner: 'Jennifer' }),
    ]);
  });

  it('receita sem conta nunca oferece cartao, e "Entrou em Nubank (Felipe)" resolve', async () => {
    h.ai.nextInterpretation = interpretation('register_income', {
      transactions: [
        item({ kind: 'income', amount_text: '50', description: 'mesada', category_slug: null }),
      ],
    });
    await h.say('Ganhei 50 reais de mesada');
    const question = h.messaging.last();
    expect(question).toContain('Em qual conta entrou?');
    expect(question).not.toContain('cartão');
    expect(question).not.toContain('Jennifer');

    await h.say('Entrou em Nubank (Felipe)');
    expect(await transactions()).toEqual([
      expect.objectContaining({ type: 'income', cents: 5000, kind: 'checking', owner: 'Felipe' }),
    ]);
    expect(h.messaging.last()).toContain('Nubank');
  });

  it('aceita o dono sem parenteses', async () => {
    h.ai.nextInterpretation = interpretation('register_income', {
      transactions: [item({ kind: 'income', amount_text: '50', description: 'mesada' })],
    });
    await h.say('Ganhei 50 reais de mesada');
    await h.say('Nubank Felipe');
    expect(await transactions()).toEqual([
      expect.objectContaining({ cents: 5000, account: 'Nubank', owner: 'Felipe' }),
    ]);
  });
});

describe('conta citada na mensagem', () => {
  it('"coloque 50 na conta nubank" cai no Nubank de quem escreveu, sem perguntar', async () => {
    h.ai.nextInterpretation = interpretation('register_income', {
      transactions: [
        item({
          kind: 'income',
          amount_text: '50',
          description: 'mesada',
          destination_account_text: 'nubank',
        }),
      ],
    });
    await h.say('Coloque 50 reais na conta nubank mesada');
    expect(await transactions()).toEqual([
      expect.objectContaining({ type: 'income', cents: 5000, kind: 'checking', owner: 'Felipe' }),
    ]);
  });

  it('"recebi da minha mae" nao rejeita: a mae e a origem, nao um membro', async () => {
    h.ai.nextInterpretation = interpretation('register_income', {
      transactions: [
        item({
          kind: 'income',
          amount_text: '50',
          description: 'mesada',
          person_text: 'minha mãe',
          destination_account_text: 'nubank',
        }),
      ],
    });
    await h.say('Coloque 50 reais no nubank, recebi da minha mãe');
    const [row] = await transactions();
    expect(row).toMatchObject({ cents: 5000, owner: 'Felipe', kind: 'checking' });
    expect(row?.descr).toContain('minha mãe');
  });

  it('pessoa desconhecida em gasto continua recusada, e diz quem existe', async () => {
    h.ai.nextInterpretation = interpretation('register_expense', {
      transactions: [item({ amount_text: '40', description: 'mercado', person_text: 'Carlos' })],
    });
    await h.say('Carlos gastou 40 no mercado');
    expect(await transactions()).toEqual([]);
    expect(h.messaging.last()).toContain('Felipe e Jennifer');
  });

  it('banco so na descricao: "cartao de credito Picpay" vai para o cartao Picpay, nao o padrao', async () => {
    h.ai.nextInterpretation = interpretation('register_expense', {
      transactions: [
        item({
          amount_text: '2,70',
          description: 'fatura Picpay',
          payment_method: 'credit',
          source_account_text: 'cartão de crédito',
        }),
      ],
    });
    await jennifer('Gastei 2,70 na fatura do cartão de crédito Picpay');
    expect(await transactions()).toEqual([
      expect.objectContaining({
        cents: 270,
        kind: 'credit_card',
        account: 'Picpay',
        owner: 'Jennifer',
      }),
    ]);
  });

  it('mesmo sem nenhum texto de conta, o banco citado na mensagem vale', async () => {
    h.ai.nextInterpretation = interpretation('register_expense', {
      transactions: [item({ amount_text: '12', description: 'beiju' })],
    });
    await jennifer('Gastei 12 em beiju Santander');
    expect(await transactions()).toEqual([
      expect.objectContaining({ cents: 1200, account: 'Santander', owner: 'Jennifer' }),
    ]);
  });

  it('cartao padrao continua valendo quando a mensagem nao cita banco', async () => {
    h.ai.nextInterpretation = interpretation('register_expense', {
      transactions: [item({ amount_text: '30', description: 'roupa', payment_method: 'credit' })],
    });
    await jennifer('Comprei 30 de roupa no cartão');
    expect(await transactions()).toEqual([
      expect.objectContaining({ cents: 3000, kind: 'credit_card', account: 'Mercado Pago' }),
    ]);
  });
});

describe('comandos digitados no celular', () => {
  it('/orçamento com acento vale como /orcamento', async () => {
    await h.say('/orçamento total 1500');
    expect(h.messaging.last()).toContain('R$ 1.500,00');
    expect(await h.count('budgets')).toBe(1);
  });

  it('/orcamento 1200 define o limite do mes todo', async () => {
    await h.say('/orcamento 1200');
    expect(h.messaging.last()).toContain('R$ 1.200,00');
    expect(await h.count('budgets')).toBe(1);
  });

  it('/renda com "dia= 10" e a conta sem @ guarda o dia e a conta', async () => {
    await jennifer('/renda 1.499,66 dia= 10 mercado pago padrão');
    const [entry] = await h.query<{ type: string; value: number | null; account: string | null }>(
      `SELECT r.schedule_type AS type, r.schedule_value AS value, a.name AS account
         FROM recurring_entries r LEFT JOIN financial_accounts a ON a.id = r.account_id`,
    );
    expect(entry).toEqual({ type: 'monthly_day', value: 10, account: 'Mercado pago' });
    expect(h.messaging.last()).toContain('todo dia 10');
  });

  it('/meta criar com a data solta no fim usa a data como prazo, nao como nome', async () => {
    await h.say('/meta criar Cada valor=100000 12/2028');
    const [goal] = await h.query<{ name: string; deadline: string | null }>(
      'SELECT name, deadline FROM financial_goals',
    );
    expect(goal?.name).toBe('Cada');
    expect(goal?.deadline).not.toBeNull();
  });
});

describe('quando o Otto nao entende', () => {
  it('mensagem com valor em reais nao fica sem resposta', async () => {
    h.ai.nextInterpretation = interpretation('unknown');
    await jennifer('12 ,00 reais Santander');
    expect(h.messaging.last()).toContain('Não entendi');
    expect(await transactions()).toEqual([]);
  });

  it('conversa sem valor continua em silencio', async () => {
    h.ai.nextInterpretation = interpretation('unknown');
    const before = h.messaging.sent.length;
    await jennifer('Santander é um banco bom');
    expect(h.messaging.sent.length).toBe(before);
  });

  it('"como adicionar dinheiro na minha conta" explica a entrada, nao o /addconta', async () => {
    h.ai.nextInterpretation = interpretation('how_to', { help_topic: 'add_money' });
    await h.say('Otto como faço para adicionar mais dinheiro em minha conta');
    const text = h.messaging.last();
    expect(text).toContain('/receita 50 mesada');
    expect(text).toContain('/saldo');
    expect(text).toContain('Não use /addconta');
  });

  it('o mesmo pedido, quando a IA falha, cai no tema certo', async () => {
    h.ai.nextInterpretation = interpretation('unknown');
    await h.say('Otto como faço para adicionar mais dinheiro em minha conta');
    expect(h.messaging.last()).toContain('Recebi 50 de mesada');
  });
});
