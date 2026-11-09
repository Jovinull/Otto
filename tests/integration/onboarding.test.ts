import { beforeEach, describe, expect, it } from 'vitest';
import { SUBREQUEST_LIMIT } from '../../src/infrastructure/database/metered';
import type { Harness } from '../fixtures/harness';
import { buttonData, createHarness, JENNIFER_ID } from '../fixtures/harness';

let h: Harness;
const MINUTE = 60_000;

/** Responde em sequencia, avancando o relogio para nao parecer reenvio. */
async function answer(...texts: string[]) {
  for (const text of texts) {
    h.setNow(h.now() + MINUTE);
    await h.say(text);
  }
}

const CONFIG_TABLES = [
  'financial_accounts',
  'recurring_entries',
  'budgets',
  'financial_goals',
  'goal_contributions',
];
async function configRows() {
  let total = 0;
  for (const table of CONFIG_TABLES) total += await h.count(table);
  return total;
}

beforeEach(async () => {
  h = await createHarness();
});

describe('cadastro guiado', () => {
  it('conduz todas as etapas e so ativa depois da confirmacao', async () => {
    await answer('/configurar');
    expect(h.messaging.last()).toContain('Etapa 1/6');
    await answer(
      'amigável',
      '4200',
      '5º dia útil',
      '3100',
      'dia 10',
      'pronto',
      'corrente Nubank 1.250,50',
      'reserva Caixinha 5000',
      'cartao Nubank Roxinho fecha 3 vence 10',
      'pronto',
      '1200 dia 5',
      'não temos',
      'varia dia 15',
      'pular',
      '99,90 dia 20',
      'netflix 55,90 dia 12',
      'pronto',
    );
    expect(h.messaging.last()).toContain('Etapa 5/6');
    expect(h.messaging.last()).toContain('renda prevista R$ 7.300,00, contas fixas R$ 1.355,80');
    await answer('900', '250', 'pular', '300', 'pular');
    expect(h.messaging.last()).toContain('Etapa 6/6');
    await answer(
      '80000',
      'não sei',
      '12/2027',
      '3000',
      'Nubank',
      '1500',
      '6000',
      'pronto',
      'todos',
    );

    const summary = h.messaging.last();
    expect(summary).toContain('Resumo do que vou ativar');
    expect(summary).toContain('Conta: Nubank (saldo R$ 1.250,50)');
    expect(summary).toContain(
      'Apartamento: entrada R$ 80.000,00, prazo 12/2027, já guardado R$ 3.000,00',
    );
    expect(await configRows()).toBe(0);

    await h.press(buttonData(h.messaging, 'c'));
    expect(h.messaging.last()).toContain('Configuração ativada ✅');
    expect(h.messaging.last()).not.toContain('Não consegui aplicar');
    expect(await h.count('financial_accounts')).toBe(3);
    expect(
      await h.count(
        'household_members',
        "json_extract(preferences, '$.defaultAccountId') IS NOT NULL",
      ),
    ).toBe(1);
    expect(await h.count('recurring_entries', "kind = 'income'")).toBe(2);
    expect(await h.count('recurring_entries', "kind = 'expense'")).toBe(4);
    expect(await h.count('budgets')).toBe(3);
    expect(await h.count('goal_contributions')).toBe(1);

    await answer('/metas');
    expect(h.messaging.last()).toContain('Reservado: R$ 3.000,00');
    expect(h.messaging.last()).toContain(
      'Aporte planejado: R$ 1.500,00/mês · Realizado neste mês: R$ 0,00',
    );
    await answer('/contas');
    expect(h.messaging.last()).toContain('Nubank (Felipe): R$ 1.250,50');
    await answer('/compromissos');
    expect(h.messaging.last()).toContain('Renda prevista em novembro/2026: R$ 7.300,00');
  });

  it('pular tudo nao inventa nenhum valor', async () => {
    await answer('/configurar', 'pular', 'pular', 'pular', 'pronto');
    for (let i = 0; i < 6; i++) await answer('pular');
    await answer('pronto');
    for (let i = 0; i < 5; i++) await answer('pular');
    for (let i = 0; i < 8; i++) await answer('pular');
    expect(h.messaging.last()).toContain('Nada informado ainda');
    await h.press(buttonData(h.messaging, 'c'));
    expect(await configRows()).toBe(0);
  });

  it('lancamentos continuam funcionando durante o cadastro', async () => {
    await answer('/configurar', 'neutro');
    await answer('gastei 30 no mercado');
    expect(h.ai.calls).toContain('gastei 30 no mercado');
    await answer('/gasto 12 pão');
    expect(await h.count('financial_transactions')).toBe(1);
    await answer('4200');
    expect(h.messaging.last()).toContain('Em que dia costuma cair a renda de Felipe');
  });

  it('pausa e retoma sem repetir perguntas respondidas', async () => {
    await answer('/configurar', 'firme', '4200', 'dia 5');
    await answer('/configurar pausar');
    expect(h.messaging.last()).toContain('pausado');
    await answer('3000');
    expect(await h.count('pending_actions', "status = 'pending'")).toBe(0);
    await answer('/configurar');
    expect(h.messaging.last()).toContain('Continuando de onde paramos');
    expect(h.messaging.last()).toContain('Quanto Jennifer costuma receber');
  });

  it('corrige uma etapa sem perder as outras', async () => {
    await answer('/configurar', 'neutro', '4200', 'dia 5', '3000', 'dia 10');
    await answer('/configurar renda');
    expect(h.messaging.last()).toContain('Vamos refazer essa parte');
    await answer('5000', 'dia 5', '3000', 'dia 10', 'pronto', 'pronto');
    for (let i = 0; i < 6; i++) await answer('pular');
    await answer('pronto');
    for (let i = 0; i < 13; i++) await answer('pular');
    expect(h.messaging.last()).toContain('Renda prevista de Felipe: R$ 5.000,00/mês');
    expect(h.messaging.last()).toContain('Tom: neutro');
  });

  it('resposta fora do formato segue como mensagem comum', async () => {
    await answer('/configurar', 'neutro');
    await answer('bom dia');
    expect(h.messaging.last()).toContain('Quanto Felipe costuma receber');
    await answer('acho que uns quatro mil');
    expect(await h.count('pending_actions', "status = 'pending' AND kind = 'onboarding'")).toBe(1);
  });

  it('a outra pessoa nao responde no lugar de quem conduz, mas pode assumir', async () => {
    await answer('/configurar', 'neutro');
    h.setNow(h.now() + MINUTE);
    await h.say('4200', { from: JENNIFER_ID });
    const [session] = await h.query<{ state: string }>('SELECT state FROM onboarding_sessions');
    expect(JSON.parse(session!.state).income).toEqual({});
    h.setNow(h.now() + MINUTE);
    await h.say('/configurar', { from: JENNIFER_ID });
    h.setNow(h.now() + MINUTE);
    await h.say('4200', { from: JENNIFER_ID });
    expect(h.messaging.last()).toContain('Em que dia costuma cair');
  });

  it('depois de concluido mostra o que falta e permite refazer', async () => {
    await answer('/configurar', 'neutro', 'pular', 'pular', 'pronto');
    for (let i = 0; i < 6; i++) await answer('pular');
    await answer('pronto');
    for (let i = 0; i < 13; i++) await answer('pular');
    await h.press(buttonData(h.messaging, 'c'));
    await answer('/configurar');
    expect(h.messaging.last()).toContain('já foi concluído');
    expect(h.messaging.last()).toContain('⬜ Contas');
  });

  it('confirmacao com tudo preenchido cabe no limite de subrequisicoes', async () => {
    await answer('/configurar', 'neutro', '4200', 'dia 5', '3000', 'dia 10', 'pronto');
    await answer(
      'corrente A 100',
      'corrente B 200',
      'reserva C 300',
      'cartao D fecha 1 vence 8',
      'pronto',
    );
    await answer('A', 'A');
    await answer('1200 dia 5', '400 dia 6', '150 dia 7', '80 dia 8', '100 dia 9');
    await answer('netflix 55 dia 1', 'spotify 22 dia 2', 'escola 900 dia 3', 'pronto');
    await answer('900', '250', '300', '200', '150');
    await answer('80000', '10000', '12/2027', '3000', 'pular', '1500', '6000', 'pronto', 'todos');
    h.setNow(h.now() + MINUTE);
    await h.press(buttonData(h.messaging, 'c'));
    expect(h.deps.meter.count).toBeLessThanOrEqual(SUBREQUEST_LIMIT);
    expect(h.messaging.last()).toContain('Configuração ativada ✅');
    expect(await h.count('recurring_entries')).toBe(10);
  });
});
