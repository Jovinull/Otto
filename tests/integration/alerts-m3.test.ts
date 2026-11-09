import { beforeEach, describe, expect, it } from 'vitest';
import { runHourly } from '../../src/application/jobs/scheduled';
import { SUBREQUEST_LIMIT } from '../../src/infrastructure/database/metered';
import type { Harness } from '../fixtures/harness';
import { createHarness } from '../fixtures/harness';

let h: Harness;

const utc = (iso: string, hour = 15) =>
  Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)), hour);

async function at(iso: string, text: string) {
  h.setNow(utc(iso));
  await h.say(text);
}

async function hourly(iso: string) {
  h.messaging.sent = [];
  const instant = utc(iso, 12);
  h.setNow(instant);
  const deps = h.fresh();
  await runHourly(deps, instant);
  expect(deps.meter.count).toBeLessThanOrEqual(SUBREQUEST_LIMIT);
  return h.messaging.texts();
}

const insight = (texts: string[]) => texts.find((t) => t.includes('Para olhar com calma'));

beforeEach(async () => {
  h = await createHarness();
  await at('2026-07-01', '/addconta corrente Principal saldo=90000 padrao');
});

describe('acompanhamento de metas', () => {
  it('avisa o que falta no mes uma unica vez', async () => {
    await at('2026-11-02', '/meta criar Viagem valor=8000 aporte=500');
    await at('2026-11-03', '/aporte Viagem 100 @Principal existente');
    const first = await hourly('2026-11-21');
    const text = first.find((t) => t.includes('metas do mês'))!;
    expect(text).toContain('Viagem: R$ 0,00 de R$ 500,00 neste mês; faltam R$ 500,00');
    expect((await hourly('2026-11-22')).some((t) => t.includes('metas do mês'))).toBe(false);
  });

  it('reconhece quando a meta do mes foi batida', async () => {
    await at('2026-11-02', '/meta criar Viagem valor=8000 aporte=500');
    await at('2026-11-03', '/aporte Viagem 500 @Principal');
    const texts = await hourly('2026-11-21');
    expect(texts.find((t) => t.includes('metas do mês'))).toContain('meta do mês batida');
  });

  it('nao avisa antes do dia 20 nem com o acompanhamento desligado', async () => {
    await at('2026-11-02', '/meta criar Viagem valor=8000 aporte=500');
    expect((await hourly('2026-11-19')).some((t) => t.includes('metas do mês'))).toBe(false);
    await at('2026-11-19', '/notificacoes meta off');
    expect((await hourly('2026-11-21')).some((t) => t.includes('metas do mês'))).toBe(false);
  });
});

describe('reconciliacoes pendentes', () => {
  it('lembra na segunda-feira e nao repete na mesma semana', async () => {
    await at('2026-11-10', '/saldo Principal 100');
    const monday = await hourly('2026-11-16');
    expect(monday.find((t) => t.includes('Saldo divergente'))).toContain('Principal');
    expect((await hourly('2026-11-16')).some((t) => t.includes('Saldo divergente'))).toBe(false);
  });

  it('nova informacao substitui a pendencia anterior', async () => {
    await at('2026-11-10', '/saldo Principal 100');
    await at('2026-11-11', '/saldo Principal 200');
    expect(await h.count('balance_reconciliations', "status = 'pending'")).toBe(1);
  });
});

describe('observacoes de gastos', () => {
  async function history(months: string[]) {
    for (const month of months) await at(`${month}-10`, '/gasto 100 ifood');
  }

  it('sem tres meses de historico nao conclui nada', async () => {
    await history(['2026-09', '2026-10']);
    await at('2026-11-11', '/gasto 400 ifood');
    expect(insight(await hourly('2026-11-16'))).toBeUndefined();
  });

  it('com historico compara ao ritmo usual sem exagero', async () => {
    await history(['2026-08', '2026-09', '2026-10']);
    await at('2026-11-11', '/gasto 400 ifood');
    const text = insight(await hourly('2026-11-16'))!;
    expect(text).toContain('Acima do costume');
    expect(text).toContain('R$ 400,00 até agora');
    expect(text).toContain('últimos 3 meses');
    expect(h.ai.analysisCalls).toBe(0);
  });

  it('reconhece reducao de gastos', async () => {
    await at('2026-08-10', '/gasto 600 mercado');
    await at('2026-09-10', '/gasto 600 mercado');
    await at('2026-10-10', '/gasto 600 mercado');
    await at('2026-11-02', '/gasto 10 mercado');
    expect(insight(await hourly('2026-11-16'))).toContain('Boa!');
  });

  it('aponta gasto fora do padrao da semana anterior', async () => {
    for (const day of ['05', '06', '07', '08', '09', '12']) {
      await at(`2026-08-${day}`, '/gasto 50 farmacia');
    }
    await at('2026-09-10', '/gasto 50 farmacia');
    await at('2026-10-10', '/gasto 50 farmacia');
    await at('2026-11-10', '/gasto 900 farmacia');
    expect(insight(await hourly('2026-11-16'))).toContain('Fora do padrão');
  });

  it('respeita a preferencia e nao repete', async () => {
    await history(['2026-08', '2026-09', '2026-10']);
    await at('2026-11-11', '/gasto 400 ifood');
    await at('2026-11-11', '/notificacoes dicas off');
    expect(insight(await hourly('2026-11-16'))).toBeUndefined();
    await at('2026-11-16', '/notificacoes dicas on');
    expect(insight(await hourly('2026-11-16'))).toBeDefined();
    expect(insight(await hourly('2026-11-16'))).toBeUndefined();
  });
});
