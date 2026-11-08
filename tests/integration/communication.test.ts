import { beforeEach, describe, expect, it } from 'vitest';
import { runHourly } from '../../src/application/jobs/scheduled';
import type { Harness } from '../fixtures/harness';
import { createHarness } from '../fixtures/harness';

let h: Harness;
const at = async (iso: string, text: string) => {
  h.setNow(
    Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)), 15),
  );
  await h.say(text);
};

beforeEach(async () => {
  h = await createHarness();
});

describe('respostas contextualizadas', () => {
  it('receita nao usa a abertura de gasto', async () => {
    await at('2026-11-10', '/receita 4200 salario');
    expect(h.messaging.last()).toMatch(
      /^(Entrou 🎉|Entrada anotada|Oba, anotado 💰): R\$ 4\.200,00/,
    );
    await at('2026-11-10', '/tom neutro');
    await at('2026-11-10', '/receita 300 freela');
    expect(h.messaging.last()).toMatch(/^Receita registrada: R\$ 300,00/);
  });

  it('aporte mostra a evolucao da meta e o pretendido do mes', async () => {
    await at('2026-11-10', '/meta entrada=10000 aporte=1000 inicial=2000');
    await at('2026-11-10', '/aporte 600');
    const text = h.messaging.last();
    expect(text).toContain('Agora são R$ 2.600,00 de R$ 10.000,00 (26%).');
    expect(text).toContain('No mês: R$ 600,00 de R$ 1.000,00 pretendidos.');
    await at('2026-11-11', '/aporte 400');
    expect(h.messaging.last()).toContain(
      'Meta do mês batida: R$ 1.000,00 de R$ 1.000,00 pretendidos.',
    );
  });

  it('fechamento mensal traz destaque, variacao e meta com numeros reais', async () => {
    await at('2026-10-10', '/gasto 100 ifood');
    await at('2026-10-11', '/gasto 400 mercado');
    await at('2026-11-05', '/gasto 150 ifood');
    await at('2026-11-06', '/gasto 200 mercado');
    await at('2026-11-07', '/meta entrada=10000 aporte=1000');
    await at('2026-11-08', '/aporte 300');
    h.messaging.sent = [];
    const firstOfMonth = Date.UTC(2026, 11, 1, 12);
    h.setNow(firstOfMonth);
    await runHourly(h.fresh(), firstOfMonth);
    const closing = h.messaging.texts().find((t) => t.includes('Fechamento de novembro/2026'))!;
    expect(closing).toContain(
      'O que mais pesou: Alimentação / Supermercado (R$ 200,00, 57% das despesas).',
    );
    expect(closing).toContain(
      'Alimentação / Delivery subiu 50% em relação ao período anterior (R$ 100,00 → R$ 150,00).',
    );
    expect(closing).toContain('No total, R$ 150,00 a menos que no período anterior. 👏');
    expect(closing).toContain('Apartamento: guardaram R$ 300,00 de R$ 1.000,00 pretendidos.');
  });

  it('sem base comparavel nao inventa variacao', async () => {
    await at('2026-11-05', '/gasto 150 ifood');
    h.messaging.sent = [];
    const firstOfMonth = Date.UTC(2026, 11, 1, 12);
    h.setNow(firstOfMonth);
    await runHourly(h.fresh(), firstOfMonth);
    const closing = h.messaging.texts().find((t) => t.includes('Fechamento'))!;
    expect(closing).not.toContain('subiu');
    expect(closing).not.toContain('a menos que');
  });
});
