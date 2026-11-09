import { beforeEach, describe, expect, it } from 'vitest';
import type { Harness } from '../fixtures/harness';
import { buttonData, createHarness, JENNIFER_ID } from '../fixtures/harness';

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

beforeEach(async () => {
  h = await createHarness();
  await say('/addconta corrente Principal saldo=3000');
  await say('/addconta corrente Secundaria saldo=1000');
  await say('/addconta reserva Cofre saldo=0');
});

describe('metas genericas', () => {
  it('cria varias metas e mantem o formato de resposta', async () => {
    await say('/meta criar Viagem valor=8000');
    await say('/meta criar Computador valor=6000 prazo=12/2027 aporte=500');
    expect(await h.count('financial_goals')).toBe(2);
    const report = await say('/meta Computador');
    expect(report).toContain('Meta: Computador');
    expect(report).toContain('Objetivo: R$ 6.000,00');
    expect(report).toContain('Faltam: R$ 6.000,00');
    expect(report).toContain('Aporte planejado: R$ 500,00/mês');
    expect(report).toContain('Projeção ignora rendimentos');
  });

  it('nao aceita nome repetido e libera o nome depois de arquivar', async () => {
    await say('/meta criar Viagem valor=8000');
    expect(await say('/meta criar viagem valor=1')).toContain('Já existe');
    await say('/meta remover Viagem');
    await confirm();
    await say('/meta criar Viagem valor=100');
    expect(await h.count('financial_goals', "status = 'active'")).toBe(1);
  });

  it('edita valor, prazo e nome com auditoria', async () => {
    await say('/meta criar Viagem valor=8000');
    await say('/meta editar Viagem valor=9000 prazo=12/2027 nome=Europa');
    expect(await say('/meta status Europa')).toContain('Objetivo: R$ 9.000,00');
    expect(await h.count('audit_events', "action = 'goal.updated'")).toBe(1);
  });

  it('comandos antigos do apartamento continuam funcionando', async () => {
    await say('/meta entrada=80000 aporte=1000');
    await say('/aporte 500');
    const report = await say('/metas');
    expect(report).toContain('Meta: Apartamento');
    expect(report).toContain('Reservado: R$ 500,00');
    expect(report).toContain('Realizado neste mês: R$ 500,00');
    expect(await h.count('financial_transactions')).toBe(0);
  });

  it('ambiguidade de meta pergunta em vez de escolher', async () => {
    await say('/meta criar Viagem Europa valor=8000');
    await say('/meta criar Viagem Chile valor=8000');
    expect(await say('/aporte Viagem 100 @Principal')).toContain('Encontrei mais de uma');
    expect(await h.count('goal_contributions')).toBe(0);
  });

  it('meta individual registra o dono e pessoa desconhecida e recusada', async () => {
    await say('/meta criar Curso valor=2000 dono=Jennifer');
    const [row] = await h.query<{ owner_member_id: string | null }>(
      'SELECT owner_member_id FROM financial_goals',
    );
    expect(row!.owner_member_id).not.toBeNull();
    expect(await say('/meta criar Moto valor=2000 dono=Fulano')).toContain('Não encontrei');
  });
});

describe('dinheiro de metas nas contas', () => {
  beforeEach(async () => {
    await say('/meta criar Viagem valor=8000');
    await say('/meta entrada=50000');
  });

  it('reserva em tres contas nao duplica o patrimonio', async () => {
    await say('/addconta corrente Terceira saldo=1000');
    await say('/editconta Principal saldo=1000');
    await say('/aporte Apartamento 1000 @Principal existente');
    await say('/aporte Apartamento 1000 @Secundaria existente');
    await say('/aporte Apartamento 1000 @Terceira existente');
    const accounts = await say('/contas');
    expect(accounts).toContain('Patrimônio em contas: R$ 3.000,00');
    expect(accounts).toContain('Reservado para metas nessas contas: R$ 3.000,00');
    expect(accounts).not.toContain('R$ 6.000,00');
    const goal = await say('/meta Apartamento');
    expect(goal).toContain('Reservado: R$ 3.000,00');
    expect(goal).toContain('Onde está:');
    expect(await h.count('financial_transactions')).toBe(0);
  });

  it('transferencia para o cofre nao e receita, despesa nem patrimonio novo', async () => {
    const reply = await say('/aporte Apartamento 500 @Cofre de:Principal');
    expect(reply).toContain('não é despesa nem receita');
    const accounts = await say('/contas');
    expect(accounts).toContain('Principal (Felipe): R$ 2.500,00');
    expect(accounts).toContain('reservado R$ 500,00');
    expect(accounts).toContain('Patrimônio em contas: R$ 4.000,00');
    expect(await h.count('financial_transactions', "type = 'transfer'")).toBe(1);
    expect(await h.count('financial_transactions', "type <> 'transfer'")).toBe(0);
    const [row] = await h.query<{ transaction_id: string | null; kind: string }>(
      'SELECT transaction_id, kind FROM goal_contributions',
    );
    expect(row!.transaction_id).not.toBeNull();
    expect(row!.kind).toBe('contribution');
  });

  it('nao reserva o mesmo dinheiro duas vezes para metas diferentes', async () => {
    await say('/aporte Apartamento 800 @Secundaria existente');
    expect(await say('/aporte Viagem 300 @Secundaria existente')).toContain('não dá para reservar');
    expect(await say('/aporte Viagem 200 @Secundaria existente')).toContain('Reserva confirmada');
    const accounts = await say('/contas');
    expect(accounts).toContain('reservado R$ 1.000,00 · livre R$ 0,00');
    expect(await h.count('goal_contributions')).toBe(2);
  });

  it('saldo desconhecido permite reservar avisando que nao validou', async () => {
    await say('/addconta corrente Misteriosa');
    const reply = await say('/aporte Viagem 200 @Misteriosa existente');
    expect(reply).toContain('não consegui validar');
    expect(await say('/contas')).toContain('sem como validar');
  });

  it('cartao nao guarda reserva', async () => {
    await say('/addconta cartao Roxo fecha=3 vence=10');
    expect(await say('/aporte Viagem 200 @Roxo existente')).toContain('Não achei');
  });

  it('retirada limitada ao que existe e pergunta quando ha varios locais', async () => {
    await say('/aporte Viagem 300 @Principal existente');
    await say('/aporte Viagem 200 @Secundaria existente');
    expect(await say('/retirada Viagem 250')).toContain('De onde sai?');
    expect(await say('/retirada Viagem 400 @Secundaria')).toContain('só há R$ 200,00');
    const reply = await say('/retirada Viagem 100 @Secundaria');
    expect(reply).toContain('Agora são R$ 400,00');
    expect(await h.count('financial_transactions')).toBe(0);
  });

  it('gasto que consome dinheiro reservado precisa de confirmacao', async () => {
    await say('/aporte Viagem 900 @Secundaria existente');
    const reply = await say('/gasto 200 mercado @Secundaria');
    expect(reply).toContain('reservados em Secundaria para Viagem');
    expect(await h.count('financial_transactions')).toBe(0);
    const done = await confirm();
    expect(done).toContain('ficaram sem saldo');
    expect(await h.count('financial_transactions')).toBe(1);
  });

  it('gasto com saldo livre segue direto', async () => {
    await say('/aporte Viagem 100 @Secundaria existente');
    await say('/gasto 200 mercado @Secundaria');
    expect(await h.count('financial_transactions')).toBe(1);
  });

  it('transferir dinheiro reservado para a meta pede confirmacao', async () => {
    await say('/aporte Viagem 3000 @Principal existente');
    const reply = await say('/aporte Apartamento 500 @Cofre de:Principal');
    expect(reply).toContain('Registrar mesmo assim?');
    expect(await h.count('financial_transactions')).toBe(0);
    await confirm();
    expect(await h.count('financial_transactions', "type = 'transfer'")).toBe(1);
    expect(await h.count('goal_contributions')).toBe(2);
  });

  it('desfazer o aporte desfaz tambem a transferencia', async () => {
    const reply = await say('/aporte Apartamento 500 @Cofre de:Principal');
    const code = /estornar (\S+)/.exec(reply)![1]!;
    await say(`/estornar ${code}`);
    expect(await confirm()).toContain('A transferência entre as contas também foi desfeita');
    expect(await say('/contas')).toContain('Principal (Felipe): R$ 3.000,00');
    expect(await h.count('goal_contributions', "status = 'confirmed'")).toBe(0);
  });

  it('estornar a transferencia libera a reserva', async () => {
    await say('/aporte Apartamento 500 @Cofre de:Principal');
    const [row] = await h.query<{ id: string }>('SELECT id FROM financial_transactions');
    await say(`/estornar ${row!.id.slice(0, 8)}`);
    await confirm();
    expect(await say('/meta Apartamento')).toContain('Reservado: R$ 0,00');
  });

  it('arquivar a meta libera a reserva sem mover dinheiro', async () => {
    await say('/aporte Viagem 500 @Principal existente');
    await say('/meta remover Viagem');
    await confirm();
    const accounts = await say('/contas');
    expect(accounts).not.toContain('reservado');
    expect(accounts).toContain('Principal (Felipe): R$ 3.000,00');
  });

  it('conta com reserva nao pode ser arquivada', async () => {
    await say('/aporte Viagem 500 @Principal existente');
    expect(await say('/removerconta Principal')).toContain('Libere com /retirada');
  });

  it('aporte repetido pelo mesmo evento nao duplica', async () => {
    h.setNow(h.now() + MINUTE);
    await h.say('/aporte Viagem 100 @Principal', { updateId: 777001, messageId: 777001 });
    await h.say('/aporte Viagem 100 @Principal', { updateId: 777001, messageId: 777001 });
    expect(await h.count('goal_contributions')).toBe(1);
  });
});

describe('reconciliacao de saldo', () => {
  it('saldo igual apenas confirma', async () => {
    expect(await say('/saldo Principal 3000')).toContain('bate');
    expect(await h.count('balance_reconciliations')).toBe(0);
  });

  it('divergencia mostra os numeros e so ajusta com aprovacao', async () => {
    const reply = await say('/saldo Principal 2800');
    expect(reply).toContain('calculei R$ 3.000,00');
    expect(reply).toContain('informou R$ 2.800,00');
    expect(reply).toContain('Não sei a causa');
    const approve = buttonData(h.messaging, 'c');
    expect(await say('/contas')).toContain('Principal (Felipe): R$ 3.000,00');
    await h.press(approve);
    expect(await say('/contas')).toContain('Principal (Felipe): R$ 2.800,00');
    expect(await h.count('financial_transactions')).toBe(0);
    expect(await h.count('audit_events', "action = 'reconciliation.adjusted'")).toBe(1);
  });

  it('cancelar nao altera o saldo', async () => {
    await say('/saldo Principal 2800');
    await h.press(buttonData(h.messaging, 'x'));
    expect(await say('/contas')).toContain('Principal (Felipe): R$ 3.000,00');
    expect(await h.count('balance_reconciliations', "status = 'dismissed'")).toBe(1);
  });

  it('informar saldo de conta desconhecida passa a conhece-la', async () => {
    await say('/addconta corrente Misteriosa');
    await say('/saldo Misteriosa 400');
    expect(await say('/contas')).toContain('Misteriosa (Felipe): R$ 400,00');
  });

  it('nao escolhe a conta pessoal do outro por engano', async () => {
    await say('/addconta corrente Nubank saldo=100 dono=Jennifer');
    await say('/addconta corrente Nubank saldo=200');
    await say('/saldo Nubank 250', JENNIFER_ID);
    const [row] = await h.query<{ opening: number }>(
      `SELECT a.opening_balance_cents AS opening FROM balance_reconciliations r
       JOIN financial_accounts a ON a.id = r.account_id`,
    );
    expect(row!.opening).toBe(10000);
  });
});
