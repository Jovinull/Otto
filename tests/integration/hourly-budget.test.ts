import { expect, it } from 'vitest';
import { runHourly } from '../../src/application/jobs/scheduled';
import { SUBREQUEST_LIMIT } from '../../src/infrastructure/database/metered';
import { createHarness } from '../fixtures/harness';

it('cron horario do pior dia (dia 1 numa segunda) cabe no limite de subrequisicoes', async () => {
  const h = await createHarness();
  const at = async (iso: string, text: string) => {
    h.setNow(
      Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)), 15),
    );
    await h.say(text);
  };
  for (const command of [
    '/addconta corrente Principal saldo=1000 padrao',
    '/addconta cartao Nubank fecha=3 vence=4',
    '/addconta cartao Inter fecha=25 vence=4',
    '/addconta cartao Itau fecha=20 vence=3',
    '/recorrente despesa 1200 dia=1 aluguel',
    '/recorrente despesa 110 dia=4 internet',
    '/recorrente despesa ? dia=3 energia',
    '/renda 4200 util=5',
    '/orcamento delivery 100',
    '/orcamento lazer 100',
    '/orcamento total 3000',
    '/meta entrada=80000 aporte=1000',
  ]) {
    await at('2026-12-20', command);
  }
  await at('2027-01-10', '/gasto 150 ifood @Nubank');
  await at('2027-01-12', '/gasto 120 cinema @Inter');
  await at('2027-01-15', '/gasto 600 mercado @Itau');
  await at('2027-01-28', '/gasto 90 ifood');
  const monday = Date.UTC(2027, 1, 1, 12); // 01/02/2027, segunda, 09:00 em Maceio
  h.setNow(monday);
  h.messaging.sent = [];
  await runHourly(h.fresh(), monday);
  console.log(`cron horario do pior dia: ${h.deps.meter.count} subrequisicoes`);
  expect(h.deps.meter.count).toBeLessThanOrEqual(SUBREQUEST_LIMIT);
  const texts = h.messaging.texts().join('\n');
  expect(texts).toContain('Fechamento de janeiro/2027');
  expect(texts).toContain('Semana de');
  expect(texts).toContain('Contas chegando');
});
