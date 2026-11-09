import { describe, expect, it } from 'vitest';
import dataset from '../../evals/interpretation.json';
import { createHarness, JENNIFER_ID, withAccounts } from '../fixtures/harness';
import type { EvalCase } from './golden';
import { toInterpretation } from './golden';

/**
 * Avaliacao offline: dada a interpretacao ideal de cada mensagem, o backend precisa gravar,
 * pedir confirmacao, perguntar ou silenciar exatamente como esperado. Nao chama a OpenAI.
 * A avaliacao do modelo real fica em `pnpm eval:openai`.
 */
const cases = dataset.cases as EvalCase[];
const CONFIG_TABLES = ['budgets', 'financial_goals', 'recurring_entries', 'goal_contributions'];

interface Outcome {
  id: string;
  kind: string;
  failures: string[];
}

async function run(evalCase: EvalCase): Promise<Outcome> {
  const h = await createHarness();
  await withAccounts(h);
  await h.say('/addconta corrente Conta_Jennifer saldo=500', { from: JENNIFER_ID });
  for (const command of evalCase.setup ?? []) await h.say(command);

  const configCount = async () => {
    let total = 0;
    for (const table of CONFIG_TABLES) total += await h.count(table);
    const [goal] = await h.query<{ planned: number | null }>(
      'SELECT planned_monthly_cents AS planned FROM financial_goals',
    );
    return `${total}:${goal?.planned ?? ''}`;
  };
  const transactionsBefore = await h.count('financial_transactions');
  const configBefore = await configCount();
  const contributionsBefore = await h.count('goal_contributions');
  const sentBefore = h.messaging.sent.length;
  const callsBefore = h.ai.calls.length;

  h.ai.nextInterpretation = toInterpretation(evalCase.golden);
  await h.say(evalCase.text);

  const wroteTransaction = (await h.count('financial_transactions')) > transactionsBefore;
  const wroteConfig = (await configCount()) !== configBefore;
  const replied = h.messaging.sent.length > sentBefore;
  const reachedModel = h.ai.calls.length > callsBefore;
  const { expect: expected } = evalCase;
  const failures: string[] = [];

  const write = wroteTransaction ? 'transaction' : wroteConfig ? 'config' : 'none';
  if (write !== expected.write) failures.push(`write: esperado ${expected.write}, obtido ${write}`);
  if (expected.reply !== undefined && replied !== expected.reply) {
    failures.push(`reply: esperado ${expected.reply}, obtido ${replied}`);
  }
  if ((expected.reachesModel ?? true) !== reachedModel) {
    failures.push(
      `filtro local: esperado ${expected.reachesModel ?? true}, obtido ${reachedModel}`,
    );
  }
  if (expected.noContribution && (await h.count('goal_contributions')) > contributionsBefore) {
    failures.push('intencao virou aporte confirmado');
  }
  return { id: evalCase.id, kind: evalCase.kind, failures };
}

describe('avaliacao offline do backend sobre interpretacoes ideais', () => {
  it(`processa os ${cases.length} casos do conjunto versionado como esperado`, async () => {
    const outcomes: Outcome[] = [];
    for (const evalCase of cases) outcomes.push(await run(evalCase));

    const byKind = new Map<string, { total: number; ok: number }>();
    for (const outcome of outcomes) {
      const entry = byKind.get(outcome.kind) ?? { total: 0, ok: 0 };
      entry.total += 1;
      if (outcome.failures.length === 0) entry.ok += 1;
      byKind.set(outcome.kind, entry);
    }
    const summary = [...byKind].map(([kind, { ok, total }]) => `${kind} ${ok}/${total}`).join(', ');
    console.log(`Avaliacao offline: ${summary}`);

    const failed = outcomes.filter((o) => o.failures.length > 0);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
  }, 120_000);
});
