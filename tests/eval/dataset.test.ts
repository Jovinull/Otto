import { describe, expect, it } from 'vitest';
import { compareInterpretation } from '../../evals/compare';
import dataset from '../../evals/interpretation.json';
import { Interpretation } from '../../src/infrastructure/ai/interpretation';
import type { EvalCase } from './golden';
import { toInterpretation } from './golden';

const cases = dataset.cases as EvalCase[];

describe('conjunto de avaliacao', () => {
  it('tem ids unicos e cobre as categorias pedidas', () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    const kinds = new Set(cases.map((c) => c.kind));
    for (const kind of [
      'registro',
      'previsao',
      'intencao',
      'pergunta',
      'ambiguo',
      'incompleto',
      'nao_financeiro',
      'correcao',
    ]) {
      expect(kinds).toContain(kind);
    }
  });

  it('cada interpretacao ideal respeita o schema estrito', () => {
    for (const evalCase of cases) {
      const parsed = Interpretation.safeParse(toInterpretation(evalCase.golden));
      expect(parsed.success, evalCase.id).toBe(true);
    }
  });

  it('o comparador aceita a interpretacao ideal de todos os casos', () => {
    for (const evalCase of cases) {
      expect(
        compareInterpretation(evalCase.expect, toInterpretation(evalCase.golden)),
        evalCase.id,
      ).toEqual([]);
    }
  });

  it('o comparador detecta valor inventado, ausente e intencao errada', () => {
    const base = cases.find((c) => c.id === 'uber-conto')!;
    const wrongAmount = toInterpretation({
      ...base.golden,
      transactions: [{ amount_text: '52', description: 'Uber' }],
    });
    expect(compareInterpretation(base.expect, wrongAmount)).toEqual(['valor_errado']);

    const partial = cases.find((c) => c.id === 'metade-salario')!;
    const invented = toInterpretation({
      intent: 'register_income',
      transactions: [{ kind: 'income', amount_text: '2100', description: 'salário' }],
    });
    expect(compareInterpretation(partial.expect, invented)).toEqual(['valor_inventado']);

    expect(
      compareInterpretation(base.expect, toInterpretation({ intent: 'not_financial' })),
    ).toEqual(['intencao', 'quantidade_de_lancamentos']);
  });
});
