import { beforeEach, describe, expect, it } from 'vitest';
import type { Harness } from '../fixtures/harness';
import { buttonData, createHarness, JENNIFER_ID } from '../fixtures/harness';

let h: Harness;
const MINUTE = 60_000;

async function answer(...texts: string[]) {
  for (const text of texts) {
    h.setNow(h.now() + MINUTE);
    await h.say(text);
  }
}

async function skip(times: number) {
  for (let i = 0; i < times; i++) await answer('pular');
}

async function finish() {
  h.setNow(h.now() + MINUTE);
  await h.press(buttonData(h.messaging, 'c'));
  return h.messaging.last();
}

const preferences = async (name: string) => {
  const [row] = await h.query<{ preferences: string }>(
    'SELECT preferences FROM household_members WHERE name = ?',
    name,
  );
  return JSON.parse(row!.preferences) as { defaultAccountId?: string; defaultCardId?: string };
};

const accountId = async (name: string, owner: string) => {
  const [row] = await h.query<{ id: string }>(
    `SELECT a.id FROM financial_accounts a JOIN household_members m ON m.id = a.owner_member_id
     WHERE a.name = ? AND m.name = ?`,
    name,
    owner,
  );
  return row!.id;
};

beforeEach(async () => {
  h = await createHarness();
});

describe('cadastro guiado com contas por pessoa', () => {
  it('registra dono, padroes, renda na conta certa, cofre e metas', async () => {
    await answer('/configurar', 'neutro', '4000', 'dia 5', '2500', 'dia 10');
    expect(h.messaging.last()).toContain('Mais alguma renda');
    await answer('Freelance 600 dia 15', 'Bico 300 irregular de Jennifer', 'pronto');
    await answer(
      'corrente MercadoPago 2000',
      'corrente Caixa 100',
      'reserva Cofre 3000',
      'cartao Santander fecha 3 vence 10',
      'corrente Nubank 750 de Jennifer',
      'cartao PicPay fecha 5 vence 12 de Jennifer',
      'conjunta Casa 1500 casal',
      'pronto',
    );
    expect(h.messaging.last()).toContain('conta principal de Felipe');
    await answer('MercadoPago');
    expect(h.messaging.last()).toContain('Em qual conta costuma cair a renda de Felipe');
    await answer('MercadoPago');
    await skip(6);
    await skip(5);
    await answer('50000', 'pular', 'pular', '3000');
    expect(h.messaging.last()).toContain('Em qual conta ou cofre');
    await answer('Cofre', '1000', 'pular');
    await answer('Viagem 8000', 'Computador 6000 até 12/2027', 'pronto');
    expect(h.messaging.last()).toContain('Por fim, alertas');
    await answer('contas');
    const text = h.messaging.last();
    expect(text).toContain('Conta: Nubank de Jennifer');
    expect(text).toContain('Conta principal de Felipe: MercadoPago');
    expect(text).toContain('Meta: Viagem, objetivo R$ 8.000,00');
    expect(text).toContain('Alertas: contas');
    expect(await h.count('financial_accounts')).toBe(0);

    expect(await finish()).toContain('Configuração ativada ✅');
    expect(await h.count('financial_accounts')).toBe(7);
    expect(await h.count('financial_goals')).toBe(3);
    expect((await preferences('Felipe')).defaultAccountId).toBe(
      await accountId('MercadoPago', 'Felipe'),
    );
    expect((await preferences('Felipe')).defaultCardId).toBe(
      await accountId('Santander', 'Felipe'),
    );
    expect((await preferences('Jennifer')).defaultAccountId).toBe(
      await accountId('Nubank', 'Jennifer'),
    );
    expect((await preferences('Jennifer')).defaultCardId).toBe(
      await accountId('PicPay', 'Jennifer'),
    );
    await answer('/compromissos');
    expect(h.messaging.last()).toContain('Renda prevista em novembro/2026: R$ 7.100,00');
    expect(h.messaging.last()).toContain('Bico (Jennifer): R$ 300,00');
    expect(h.messaging.last()).toContain('Salário (Felipe): R$ 4.000,00');
    expect(h.messaging.last()).toContain('MercadoPago');
    expect(h.messaging.last()).toContain('Salário (Jennifer): R$ 2.500,00');
    await answer('/meta Apartamento');
    expect(h.messaging.last()).toContain('Onde está: Cofre R$ 3.000,00');
    await answer('/contas');
    expect(h.messaging.last()).toContain('reservado R$ 3.000,00 · livre R$ 0,00');

    const [house] = await h.query<{ settings: string }>('SELECT settings FROM households');
    const { notifications } = JSON.parse(house!.settings) as {
      notifications: { weeklySummary: boolean; billReminders: boolean };
    };
    expect(notifications).toMatchObject({ weeklySummary: false, billReminders: true });
  });

  it('nao recria o que existe e avisa antes de confirmar', async () => {
    await answer('/addconta corrente Nubank saldo=900', '/renda 3000 dia=5');
    await answer('/configurar', 'neutro', '4000', 'dia 5', 'pular', 'pronto');
    await answer('corrente Nubank 100', 'pronto');
    await skip(6);
    await skip(5);
    await skip(8);
    const text = h.messaging.last();
    expect(text).toContain('⚠️ Nubank já existe');
    expect(text).toContain('Renda de Felipe: hoje é R$ 3.000,00; vou trocar para R$ 4.000,00');
    expect(await finish()).toContain('Já existiam e ficaram como estavam: Nubank');
    expect(await h.count('financial_accounts')).toBe(1);
    await answer('/contas');
    expect(h.messaging.last()).toContain('Nubank (Felipe): R$ 900,00');
  });

  it('mostra quando a reserva informada passa do saldo', async () => {
    await answer('/configurar', 'neutro', 'pular', 'pular', 'reserva Cofre 100', 'pronto');
    await skip(6);
    await skip(5);
    await answer('pular', 'pular', 'pular', '500', 'Cofre', 'pular', 'pular', 'pronto', 'todos');
    expect(h.messaging.last()).toContain('⚠️ R$ 500,00 reservados em Cofre');
  });

  it('nome de conta com "de" nao vira dono por engano', async () => {
    await answer('/configurar', 'neutro', 'pular', 'pular', 'corrente Banco de Brasilia 10');
    await answer('pronto');
    await skip(6);
    await skip(5);
    await skip(8);
    expect(h.messaging.last()).toContain('Conta: Banco de Brasilia (saldo R$ 10,00)');
  });

  it('a mesma instituicao para cada pessoa cria duas contas', async () => {
    await answer('/addconta corrente Nubank saldo=1');
    await h.say('/ok', { from: JENNIFER_ID });
    await answer('/configurar', 'neutro', 'pular', 'pular', 'corrente Nubank 5 de Jennifer');
    await answer('pronto');
    await skip(6);
    await skip(5);
    await skip(8);
    await finish();
    expect(await h.count('financial_accounts')).toBe(2);
  });

  it('corrige so a etapa de alertas', async () => {
    await answer('/configurar', 'neutro', 'pular', 'pular', 'pronto');
    await skip(6);
    await skip(5);
    await skip(8);
    await answer('/configurar alertas');
    expect(h.messaging.last()).toContain('Por fim, alertas');
    await answer('nenhum');
    expect(h.messaging.last()).toContain('Alertas: nenhum');
  });
});
