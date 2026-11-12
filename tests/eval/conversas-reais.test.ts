import { describe, expect, it } from 'vitest';
import type { Expectation } from '../../evals/compare';
import { compareInterpretation } from '../../evals/compare';
import dataset from '../../evals/conversas-reais.json';
import { HELP_TOPICS, INTENTS } from '../../src/infrastructure/ai/interpretation';
import { interpretation, item } from '../fixtures/harness';

const cases = dataset.cases as { id: string; text: string; expect: Expectation }[];

describe('conjunto das conversas reais', () => {
  it('tem ids unicos e so usa intencoes e temas que existem', () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const { id, expect: wanted } of cases) {
      for (const intent of wanted.intents) {
        expect(INTENTS as readonly string[], id).toContain(intent);
      }
      for (const topic of wanted.helpTopics ?? []) {
        expect(HELP_TOPICS as readonly string[], id).toContain(topic);
      }
    }
  });

  it('o comparador acusa pessoa de fora e conta errada', () => {
    const wanted = cases.find((c) => c.id === 'cr1')!.expect;
    const right = interpretation('register_income', {
      transactions: [
        item({
          kind: 'income',
          amount_text: '50',
          description: 'mesada',
          destination_account_text: 'nubank',
        }),
      ],
    });
    expect(compareInterpretation(wanted, right)).toEqual([]);

    const outsider = interpretation('register_income', {
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
    expect(compareInterpretation(wanted, outsider)).toEqual(['pessoa_de_fora']);

    const noAccount = interpretation('register_income', {
      transactions: [item({ kind: 'income', amount_text: '50', description: 'mesada' })],
    });
    expect(compareInterpretation(wanted, noAccount)).toEqual(['conta']);
  });
});
