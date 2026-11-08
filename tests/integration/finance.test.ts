import { beforeEach, describe, expect, it } from 'vitest';
import type { Harness } from '../fixtures/harness';
import {
  buttonData,
  createHarness,
  DEFAULT_NOW,
  interpretation,
  item,
  JENNIFER_ID,
  withAccounts,
} from '../fixtures/harness';

interface TxRow {
  id: string;
  type: string;
  transfer_kind: string | null;
  amount_cents: number;
  category_id: string | null;
  financial_date: string;
  member_id: string;
  status: string;
}

let h: Harness;
const txs = () => h.query<TxRow>('SELECT * FROM financial_transactions ORDER BY created_at');
const code = (id: string) => id.replaceAll('-', '').slice(0, 6);
const slugOf = async (categoryId: string | null) =>
  (await h.query<{ slug: string }>('SELECT slug FROM categories WHERE id = ?', categoryId))[0]
    ?.slug;

async function aiSays(text: string, value: ReturnType<typeof interpretation>, options = {}) {
  h.ai.nextInterpretation = value;
  await h.say(text, options);
}

beforeEach(async () => {
  h = await createHarness();
});

describe('registros', () => {
  it('1. registra despesa simples por comando e confirma apos persistir', async () => {
    await h.say('/gasto 27 Uber');
    const [row] = await txs();
    expect(row).toMatchObject({
      type: 'expense',
      amount_cents: 2700,
      financial_date: '2026-11-10',
    });
    expect(await slugOf(row!.category_id)).toBe('transporte');
    expect(h.messaging.last()).toContain('R$ 27,00');
    expect(h.messaging.last()).toContain('Transporte');
  });

  it('2. registra receita', async () => {
    await aiSays(
      'Recebi meu salário de 4200 reais.',
      interpretation('register_income', {
        transactions: [
          item({
            kind: 'income',
            amount_text: '4200',
            description: 'salário',
            category_slug: 'salario',
          }),
        ],
      }),
    );
    const [row] = await txs();
    expect(row).toMatchObject({ type: 'income', amount_cents: 420000 });
    expect(await slugOf(row!.category_id)).toBe('salario');
    expect(h.messaging.last()).toContain('R$ 4.200,00');
  });

  it('3. interpreta BRL com virgula decimal', async () => {
    await h.say('/gasto 38,50 farmácia');
    expect((await txs())[0]!.amount_cents).toBe(3850);
    await h.say('/gasto 1.250,00 notebook');
    expect((await txs())[1]!.amount_cents).toBe(125000);
  });

  it('atribui despesa a outra pessoa', async () => {
    await aiSays(
      'Jennifer gastou 38,50 na farmácia.',
      interpretation('register_expense', {
        transactions: [
          item({
            amount_text: '38,50',
            description: 'farmácia',
            person_text: 'Jennifer',
            category_slug: 'farmacia',
          }),
        ],
      }),
    );
    const [row] = await txs();
    const [jennifer] = await h.query<{ id: string }>(
      'SELECT id FROM household_members WHERE telegram_user_id = ?',
      JENNIFER_ID,
    );
    expect(row!.member_id).toBe(jennifer!.id);
  });

  it('4. registra duas despesas de uma mensagem atomicamente', async () => {
    await aiSays(
      'Gastei 20 no almoço e 15 no estacionamento.',
      interpretation('register_expense', {
        transactions: [
          item({ amount_text: '20', description: 'almoço', category_slug: 'restaurantes' }),
          item({ amount_text: '15', description: 'estacionamento', category_slug: 'transporte' }),
        ],
      }),
    );
    expect((await txs()).map((t) => t.amount_cents)).toEqual([2000, 1500]);
    expect(h.messaging.sent).toHaveLength(1);
  });

  it('usa a data da mensagem e o fuso do Household para "ontem"', async () => {
    // 02:00 UTC do dia 01/12 ainda e 30/11 em Maceio; "ontem" e 29/11.
    h.setNow(Date.UTC(2026, 11, 1, 2, 0));
    await h.say('/gasto 10 padaria ontem');
    expect((await txs())[0]!.financial_date).toBe('2026-11-29');
  });

  it('pede esclarecimento quando ha varias contas sem padrao e conclui com a resposta', async () => {
    await h.say('/addconta corrente Alfa');
    await h.say('/addconta corrente Beta');
    await h.say('/gasto 30 padaria');
    expect(await txs()).toHaveLength(0);
    expect(h.messaging.last()).toContain('De qual conta saiu?');
    await h.say('beta');
    expect(await txs()).toHaveLength(1);
    expect(h.messaging.last()).toContain('Beta');
  });

  it('valor ambiguo nao e gravado silenciosamente', async () => {
    await h.say('/gasto 12.50 lanche');
    expect(await txs()).toHaveLength(0);
    expect(h.messaging.last()).toContain('R$ 12,50');
    await h.say('sim');
    expect((await txs())[0]!.amount_cents).toBe(1250);
  });
});

describe('transferencias e cartao', () => {
  beforeEach(() => withAccounts(h));

  it('5. transferencia nao vira receita nem despesa e preserva o total', async () => {
    await h.say('/transferir 500 Principal para Reserva');
    expect((await txs())[0]).toMatchObject({ type: 'transfer', transfer_kind: 'internal' });
    await h.say('/resumo');
    expect(h.messaging.last()).toContain('Entrou: R$ 0,00 · Saiu: R$ 0,00');
    await h.say('/contas');
    const report = h.messaging.last();
    expect(report).toContain('Principal: R$ 500,00');
    expect(report).toContain('Reserva: R$ 1.000,00');
  });

  it('18. compra no cartao e pagamento da fatura nao duplicam a despesa', async () => {
    await h.say('/gasto 300 sapato cartao @Nubank');
    await h.say('/contas');
    expect(h.messaging.last()).toContain('dívida em aberto R$ 300,00');
    expect(h.messaging.last()).toContain('Principal: R$ 1.000,00');

    await h.say('/pagar_fatura 300 Principal para Nubank');
    await h.say('/resumo');
    expect(h.messaging.last()).toContain('Saiu: R$ 300,00');

    await h.say('/contas');
    expect(h.messaging.last()).toContain('dívida em aberto R$ 0,00');
    expect(h.messaging.last()).toContain('Principal: R$ 700,00');
  });

  it('parcelamento guarda cronograma sem inventar vencimento', async () => {
    await h.say('/gasto 1200 celular cartao 6x');
    const [tx] = await txs();
    expect(tx!.amount_cents).toBe(120000);
    const parts = await h.query<{ amount_cents: number; due_date: string | null }>(
      'SELECT amount_cents, due_date FROM installments ORDER BY sequence',
    );
    expect(parts).toHaveLength(6);
    expect(parts.every((p) => p.amount_cents === 20000 && p.due_date === null)).toBe(true);
    expect(h.messaging.last()).toContain('Sem data de 1º vencimento');

    await h.say(`/parcela_data ${code(tx!.id)} 10/12/2026`);
    const dated = await h.query<{ due_date: string }>(
      'SELECT due_date FROM installments ORDER BY sequence',
    );
    expect(dated.map((d) => d.due_date)).toEqual([
      '2026-12-10',
      '2027-01-10',
      '2027-02-10',
      '2027-03-10',
      '2027-04-10',
      '2027-05-10',
    ]);
    await h.say('/parcelas');
    expect(h.messaging.last()).toContain('restam R$ 1.200,00');
  });

  it('compra parcelada conta uma unica vez no total do mes', async () => {
    await h.say('/gasto 1200 celular cartao 6x');
    await h.say('/resumo');
    expect(h.messaging.last()).toContain('Saiu: R$ 1.200,00');
  });

  it('aceita saldo inicial zero como saldo conhecido', async () => {
    await h.say('/addconta reserva Caixinha saldo=0');
    await h.say('/transferir 300 Principal para Caixinha');
    await h.say('/contas');
    expect(h.messaging.last()).toContain('Caixinha: R$ 300,00');
  });

  it('saldo desconhecido nunca e apresentado como saldo real', async () => {
    await h.say('/addconta corrente SemSaldo');
    await h.say('/contas');
    expect(h.messaging.last()).toContain('saldo inicial desconhecido');
    expect(h.messaging.last()).toContain('Não dá para afirmar o total disponível');
  });
});

describe('consultas', () => {
  it('6/7/8. totaliza por periodo, categoria e pessoa com filtros reais', async () => {
    await h.say('/gasto 100 mercado');
    await h.say('/gasto 50 ifood');
    await h.say('/gasto 80 mercado', { from: JENNIFER_ID });
    h.setNow(Date.UTC(2026, 9, 15, 15));
    await h.say('/gasto 999 mercado');
    h.setNow(DEFAULT_NOW);

    await aiSays(
      'Quanto gastamos este mês?',
      interpretation('query_spending', {
        query: { period: 'this_month', month_text: null, category_slug: null, person_text: null },
      }),
    );
    expect(h.messaging.last()).toContain('R$ 230,00');

    await aiSays(
      'Quanto Jennifer gastou com supermercado?',
      interpretation('query_spending', {
        query: {
          period: 'this_month',
          month_text: null,
          category_slug: 'supermercado',
          person_text: 'Jennifer',
        },
      }),
    );
    expect(h.messaging.last()).toContain('Jennifer gastou R$ 80,00');

    await aiSays(
      'Quanto eu gastei com delivery?',
      interpretation('query_spending', {
        query: {
          period: 'this_month',
          month_text: null,
          category_slug: 'delivery',
          person_text: 'eu',
        },
      }),
    );
    expect(h.messaging.last()).toContain('Felipe gastou R$ 50,00');

    await aiSays(
      'E quanto gastamos em outubro?',
      interpretation('query_spending', {
        query: { period: null, month_text: 'outubro', category_slug: null, person_text: null },
      }),
    );
    expect(h.messaging.last()).toContain('R$ 999,00');
  });

  it('nao inventa resultado sem dados', async () => {
    await aiSays(
      'Quanto gastamos este mês?',
      interpretation('query_spending', {
        query: { period: 'this_month', month_text: null, category_slug: null, person_text: null },
      }),
    );
    expect(h.messaging.last()).toContain('Não encontrei gastos');
  });

  it('entradas e saidas de 7 dias ignoram lancamento antigo', async () => {
    await h.say('/receita 500 freela');
    await h.say('/gasto 40 uber');
    h.setNow(DEFAULT_NOW - 20 * 86_400_000);
    await h.say('/gasto 700 velho');
    h.setNow(DEFAULT_NOW);
    await aiSays(
      'Quanto entrou e saiu nos últimos sete dias?',
      interpretation('query_cashflow', {
        query: { period: 'last_7_days', month_text: null, category_slug: null, person_text: null },
      }),
    );
    expect(h.messaging.last()).toContain('Entrou: R$ 500,00');
    expect(h.messaging.last()).toContain('Saiu em despesas: R$ 40,00');
  });

  it('relatorio individual separa compartilhado', async () => {
    await h.say('/gasto 100 mercado casal');
    await h.say('/gasto 30 lanche', { from: JENNIFER_ID });
    await h.say('/individual');
    expect(h.messaging.last()).toContain('Felipe: individual R$ 0,00 · compartilhado R$ 100,00');
    expect(h.messaging.last()).toContain('Jennifer: individual R$ 30,00');
  });

  it('comparativo so usa categorias com base suficiente', async () => {
    await h.say('/comparar');
    expect(h.messaging.last()).toContain('não há dados comparáveis');
    h.setNow(Date.UTC(2026, 9, 5, 15));
    await h.say('/gasto 100 ifood');
    h.setNow(DEFAULT_NOW);
    await h.say('/gasto 125 ifood');
    await h.say('/comparar');
    expect(h.messaging.last()).toContain('+25%');
  });
});

describe('correcao e estorno', () => {
  it('10. corrige valor com auditoria', async () => {
    await h.say('/gasto 27 Uber');
    const [row] = await txs();
    await h.say(`/corrigir ${code(row!.id)} valor 30,00`);
    expect((await txs())[0]!.amount_cents).toBe(3000);
    const [audit] = await h.query<{ before: string; after: string }>(
      "SELECT before, after FROM audit_events WHERE action = 'transaction.amount_corrected'",
    );
    expect(JSON.parse(audit!.before)).toEqual({ amountCents: 2700 });
    expect(JSON.parse(audit!.after)).toEqual({ amountCents: 3000 });
  });

  it('11. corrige categoria', async () => {
    await h.say('/gasto 27 Uber');
    const [row] = await txs();
    await h.say(`/corrigir ${code(row!.id)} categoria lazer`);
    expect(await slugOf((await txs())[0]!.category_id)).toBe('lazer');
  });

  it('corrige data', async () => {
    await h.say('/gasto 27 Uber');
    const [row] = await txs();
    await h.say(`/corrigir ${code(row!.id)} data 03/11`);
    expect((await txs())[0]!.financial_date).toBe('2026-11-03');
  });

  it('12. estorno exige confirmacao, some dos totais e preserva o historico', async () => {
    await h.say('/gasto 27 Uber');
    const [row] = await txs();
    await h.say(`/estornar ${code(row!.id)}`);
    expect((await txs())[0]!.status).toBe('confirmed');

    await h.press(buttonData(h.messaging, 'c'));
    expect((await txs())[0]!.status).toBe('voided');
    await h.say('/resumo');
    expect(h.messaging.last()).toContain('Ainda não tenho lançamentos');
    expect(await h.count('audit_events', "action = 'transaction.voided'")).toBe(1);
  });

  it('cancelar nao altera nada e botao nao pode ser reutilizado', async () => {
    await h.say('/gasto 27 Uber');
    const [row] = await txs();
    await h.say(`/estornar ${code(row!.id)}`);
    const cancelData = buttonData(h.messaging, 'x');
    const confirmData = buttonData(h.messaging, 'c');
    await h.press(cancelData);
    expect((await txs())[0]!.status).toBe('confirmed');
    await h.press(confirmData);
    expect((await txs())[0]!.status).toBe('confirmed');
    expect(h.messaging.last()).toContain('não está mais válida');
  });

  it('confirmacao via IA aplica a correcao somente apos o sim', async () => {
    await h.say('/gasto 27 Uber');
    const [row] = await txs();
    await aiSays(
      'corrige o último para 30',
      interpretation('correct_transaction', {
        correction: { transaction_ref: null, field: 'amount', value_text: '30' },
      }),
    );
    expect((await txs())[0]!.amount_cents).toBe(2700);
    await h.say('sim');
    expect((await txs())[0]!.amount_cents).toBe(3000);
    expect((await txs())[0]!.id).toBe(row!.id);
  });
});

describe('orcamento', () => {
  it('13. calcula disponivel', async () => {
    await h.say('/orcamento delivery 250');
    await h.say('/gasto 100 ifood');
    await aiSays(
      'Quanto ainda podemos gastar com delivery?',
      interpretation('query_budget', {
        query: { period: null, month_text: null, category_slug: 'delivery', person_text: null },
      }),
    );
    expect(h.messaging.last()).toContain('R$ 100,00 de R$ 250,00 (40%), restam R$ 150,00');
  });

  it('14/15. alerta uma vez por limiar e nao repete', async () => {
    await h.say('/orcamento delivery 100');
    await h.say('/gasto 85 ifood');
    expect(h.messaging.last()).toContain('85%');
    expect(await h.count('budget_alerts')).toBe(1);

    await h.say('/gasto 1 ifood');
    expect(await h.count('budget_alerts')).toBe(1);

    await h.say('/gasto 14 ifood');
    expect(await h.count('budget_alerts', 'threshold = 100')).toBe(1);
    await h.say('/gasto 1 ifood');
    expect(h.messaging.last()).toMatch(/estourou em R\$ 1,00|Passou R\$ 1,00/);
    expect(await h.count('budget_alerts')).toBe(3);

    await h.say('/gasto 1 ifood');
    expect(await h.count('budget_alerts')).toBe(3);
  });

  it('atualiza limite existente sem duplicar', async () => {
    await h.say('/orcamento lazer 100');
    await h.say('/orcamento lazer 150');
    expect(await h.count('budgets')).toBe(1);
    await h.say('/orcamento');
    expect(h.messaging.last()).toContain('R$ 150,00');
  });

  it('orcamento individual considera apenas a pessoa', async () => {
    await h.say('/orcamento lazer 100 de=Jennifer');
    await h.say('/gasto 90 cinema');
    await h.say('/orcamento');
    expect(h.messaging.last()).toContain('R$ 0,00 de R$ 100,00');
    await h.say('/gasto 90 cinema', { from: JENNIFER_ID });
    await h.say('/orcamento');
    expect(h.messaging.last()).toContain('R$ 90,00 de R$ 100,00');
  });

  it('transferencia nao consome orcamento', async () => {
    await withAccounts(h);
    await h.say('/orcamento total 100');
    await h.say('/transferir 500 Principal para Reserva');
    await h.say('/orcamento');
    expect(h.messaging.last()).toContain('R$ 0,00 de R$ 100,00');
  });
});

describe('meta do apartamento', () => {
  it('16. calcula progresso', async () => {
    await h.say('/meta entrada=80000 custos=20000 prazo=10/2027');
    await h.say('/aporte 25000');
    await h.say('/metas');
    const report = h.messaging.last();
    expect(report).toContain('Guardado e confirmado: R$ 25.000,00');
    expect(report).toContain('Progresso: 25%');
    expect(report).toContain('Falta: R$ 75.000,00');
    expect(report).toContain('R$ 6.250,00/mês por 12 meses');
    expect(report).toContain('ignora rendimentos');
  });

  it('17. aporte pretendido nao conta como guardado', async () => {
    await h.say('/meta entrada=80000 aporte=1500');
    await h.say('/metas');
    expect(h.messaging.last()).toContain('Guardado e confirmado: R$ 0,00');
    expect(h.messaging.last()).toContain('Realizado neste mês: R$ 0,00');
    expect(await h.count('goal_contributions')).toBe(0);
  });

  it('meta nasce sem valores inventados e reserva fica separada', async () => {
    await h.say('/metas');
    expect(h.messaging.last()).toContain('ainda não criada');
    await h.say('/meta reserva=5000');
    await h.say('/metas');
    expect(h.messaging.last()).toContain('Valor-alvo ainda não definido');
    expect(await h.count('goal_contributions')).toBe(0);
  });

  it('transferencia para reserva nao entra automaticamente na meta', async () => {
    await withAccounts(h);
    await h.say('/meta entrada=80000');
    await h.say('/transferir 500 Principal para Reserva');
    await h.say('/metas');
    expect(h.messaging.last()).toContain('Guardado e confirmado: R$ 0,00');
  });

  it('aporte pode ser desfeito com confirmacao', async () => {
    await h.say('/meta entrada=80000');
    await h.say('/aporte 500');
    const match = /desfazer_aporte (\w+)/.exec(h.messaging.last());
    await h.say(`/desfazer_aporte ${match![1]}`);
    await h.press(buttonData(h.messaging, 'c'));
    await h.say('/metas');
    expect(h.messaging.last()).toContain('Guardado e confirmado: R$ 0,00');
  });

  it('intencao em linguagem natural nao cria aporte', async () => {
    await h.say('/meta entrada=80000');
    await aiSays(
      'Quero guardar 1500 por mês',
      interpretation('set_goal', {
        goal: {
          entry_text: null,
          additional_costs_text: null,
          deadline_text: null,
          planned_monthly_text: '1500',
          emergency_reserve_text: null,
          initial_confirmed_text: null,
          contribution_text: null,
        },
      }),
    );
    expect(await h.count('goal_contributions')).toBe(0);
  });
});

describe('recorrencias e previsao', () => {
  it('19. receita prevista nao se confunde com recebida', async () => {
    await h.say('/renda 4200 util=5');
    await h.say('/compromissos');
    expect(h.messaging.last()).toContain('Renda prevista em novembro/2026: R$ 4.200,00');
    expect(h.messaging.last()).toContain('a receber');
    expect(h.messaging.last()).toContain('Recebido confirmado no mês: R$ 0,00');
    expect(await h.count('financial_transactions')).toBe(0);

    await h.say('/receita 4200 salário');
    await h.say('/compromissos');
    expect(h.messaging.last()).toContain('✅ recebido');
    expect(h.messaging.last()).toContain('Recebido confirmado no mês: R$ 4.200,00');
  });

  it('compromisso nao fica pago sozinho; pagamento relatado da baixa uma vez', async () => {
    await h.say('/recorrente despesa 1200 dia=5 aluguel');
    await h.say('/compromissos');
    expect(h.messaging.last()).toContain('aluguel: R$ 1.200,00');
    expect(await h.count('recurring_settlements')).toBe(0);

    await h.say('/gasto 1200 aluguel');
    expect(h.messaging.last()).toContain('como pago');
    await h.say('/compromissos');
    expect(h.messaging.last()).toContain('estão pagas');

    await h.say('/gasto 1200 aluguel');
    expect(await h.count('recurring_settlements')).toBe(1);
  });

  it('estorno reabre a conta prevista', async () => {
    await h.say('/recorrente despesa 1200 dia=5 aluguel');
    await h.say('/gasto 1200 aluguel');
    const [row] = await txs();
    await h.say(`/estornar ${code(row!.id)}`);
    await h.press(buttonData(h.messaging, 'c'));
    expect(await h.count('recurring_settlements')).toBe(0);
  });

  it('entende compromisso em linguagem natural', async () => {
    await aiSays(
      'Nosso aluguel é 1200 reais e vence todo dia 5.',
      interpretation('register_commitment', {
        commitment: {
          kind: 'expense',
          description: 'aluguel',
          amount_text: '1200',
          due_day: 5,
          nth_business_day: null,
          person_text: null,
          category_slug: 'moradia',
        },
      }),
    );
    expect(h.messaging.last()).toContain('É previsão');
    expect(await h.count('financial_transactions')).toBe(0);
    expect(await h.count('recurring_entries')).toBe(1);
  });

  it('dia util e mostrado como aproximado', async () => {
    await h.say('/renda 4200 util=5');
    expect(h.messaging.last()).toContain('sem considerar feriados');
  });
});

describe('consultoria', () => {
  it('consulta de compra usa dados reais', async () => {
    await h.say('/orcamento delivery 250');
    await h.say('/gasto 100 ifood');
    await aiSays(
      'Será que podemos pedir uma pizza de 90 reais?',
      interpretation('consult_purchase', {
        purchase: { amount_text: '90', description: 'pizza', category_slug: 'delivery' },
      }),
    );
    const reply = h.messaging.last();
    expect(reply).toContain('Cabe');
    expect(reply).toContain('R$ 60,00');
    expect(await h.count('financial_transactions')).toBe(1);
  });

  it('sem renda cadastrada admite que nao sabe a folga', async () => {
    await aiSays(
      'Podemos gastar 90?',
      interpretation('consult_purchase', {
        purchase: { amount_text: '90', description: 'jantar', category_slug: null },
      }),
    );
    expect(h.messaging.last()).toContain('Não sei dizer a folga real');
  });

  it('avisa quando o gasto passa o orcamento', async () => {
    await h.say('/orcamento delivery 50');
    await aiSays(
      'Podemos pedir uma pizza de 90?',
      interpretation('consult_purchase', {
        purchase: { amount_text: '90', description: 'pizza', category_slug: 'delivery' },
      }),
    );
    expect(h.messaging.last()).toContain('passa o orçamento');
  });

  it('analise fundamentada e entregue; numero inventado cai no relatorio deterministico', async () => {
    await h.say('/gasto 100 ifood');
    h.ai.analysisText = 'Delivery somou R$ 100,00 neste mês.';
    await aiSays('me dá uma análise do mês', interpretation('request_analysis'));
    expect(h.messaging.last()).toBe('Delivery somou R$ 100,00 neste mês.');

    h.ai.analysisText = 'Vocês têm R$ 54.321,00 sobrando!';
    await aiSays('outra análise', interpretation('request_analysis'));
    expect(h.messaging.last()).not.toContain('54.321');
    expect(h.messaging.last()).toContain('Resumo de novembro/2026');
  });
});

describe('configuracao', () => {
  it('checklist identifica o que falta sem bloquear lancamentos', async () => {
    await h.say('/configurar');
    expect(h.messaging.last()).toContain('⬜ Contas');
    await h.say('/gasto 10 pão');
    expect(await h.count('financial_transactions')).toBe(1);
  });

  it('muda o tom e reflete na resposta', async () => {
    await h.say('/tom neutro');
    await h.say('/gasto 10 pão');
    expect(h.messaging.last()).toContain('Registrado');
  });

  it('nenhum dado financeiro ficticio e criado no bootstrap', async () => {
    expect(await h.count('financial_transactions')).toBe(0);
    expect(await h.count('financial_accounts')).toBe(0);
    expect(await h.count('budgets')).toBe(0);
    expect(await h.count('financial_goals')).toBe(0);
    expect(await h.count('recurring_entries')).toBe(0);
  });
});
