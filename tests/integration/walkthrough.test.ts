import { expect, it } from 'vitest';
import { createHarness, JENNIFER_ID } from '../fixtures/harness';

const PROBLEM =
  /Formato|Não achei|Não encontrei|Não conheço|inválid|Não entendi|Faltou|Qual delas|De qual conta/;

/** O roteiro entregue ao casal, comando por comando: se algo aqui quebrar, o guia esta errado. */
it('o roteiro de configuracao e de uso diario funciona como descrito', async () => {
  const h = await createHarness();
  const run = async (text: string, from?: string) => {
    h.setNow(h.now() + 60_000);
    await h.say(text, from === undefined ? undefined : { from });
    const reply = h.messaging.last();
    expect(reply, text).not.toMatch(PROBLEM);
    return reply;
  };

  // Configuracao
  for (const command of [
    '/addconta corrente Mercado Pago saldo=2000 padrao',
    '/addconta corrente Nubank saldo=800',
    '/addconta cartao Santander fecha=3 vence=10 limite=5000 padrao',
    '/addconta reserva Cofre saldo=3000',
    '/addconta conjunta Casa saldo=1500',
    '/renda 4000 dia=5 @Mercado Pago',
    '/renda 600 nome=Freelance irregular',
    '/recorrente 1200 dia=5 aluguel',
    '/recorrente ? dia=10 energia',
    '/orcamento delivery 250',
    '/orcamento total 3000',
    '/meta entrada=50000 prazo=12/2027 aporte=1500',
    '/meta criar Viagem valor=8000 prazo=12/2027 aporte=300',
    '/meta criar Emergencia valor=12000',
    '/vincular Apartamento @Cofre',
    '/aporte Apartamento 3000 @Cofre existente',
  ]) {
    await run(command);
  }
  for (const command of [
    '/addconta corrente Nubank saldo=750 padrao',
    '/addconta cartao PicPay fecha=5 vence=12 padrao',
    '/renda 2500 dia=10 @Nubank',
  ]) {
    await run(command, JENNIFER_ID);
  }

  // Dia a dia
  await run('/gasto 27 uber');
  await run('/gasto 300 tenis cartao 3x');
  await run('/gasto 80 feira casal');
  await run('/gasto 45 farmacia', JENNIFER_ID);
  await run('/gasto 30 lanche @Nubank');
  await run('/receita 900 bonus');
  expect(await run('/recebi salario')).toContain('R$ 4.000,00');
  await run('/transferir 200 Nubank para Mercado Pago');
  await run('/aporte Viagem 300 @Cofre de:Mercado Pago');
  await run('/retirada Viagem 100 @Cofre');
  await run('/pagar_fatura 100 Mercado Pago para Santander');
  await run('/saldo Nubank 730');

  for (const query of [
    '/statuspessoal',
    '/statuscasal',
    '/resumo',
    '/semana',
    '/comparar',
    '/contas',
    '/minhascontas',
    '/compromissos',
    '/orcamento',
    '/metas',
    '/meta Viagem',
    '/fatura',
    '/parcelas',
    '/ultimos',
    '/notificacoes',
    '/configurar status',
    '/comandos',
    '/ajuda meta',
  ]) {
    expect((await run(query)).length, query).toBeGreaterThan(0);
  }
  expect(await h.count('financial_transactions', "type = 'expense'")).toBe(5);
  expect(await h.count('installments')).toBe(3);
  expect(await run('/meta Viagem')).toContain('Reservado: R$ 200,00');
});
