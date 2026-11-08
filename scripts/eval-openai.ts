// Avaliacao real da interpretacao contra evals/interpretation.json. So roda com --yes.
// Uso: pnpm eval:openai -- --yes [--limit 10] [--only uber-conto]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { ErrorCategory, Expectation } from '../evals/compare';
import { compareInterpretation } from '../evals/compare';
import { costUsd, explainAiError, requireConsent, setupOpenAi } from './openai-common';

interface Case {
  id: string;
  kind: string;
  text: string;
  expect: Expectation;
}

const option = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const dataset = JSON.parse(readFileSync('evals/interpretation.json', 'utf8')) as {
  version: number;
  cases: Case[];
};
const only = option('--only');
const limit = Number(option('--limit') ?? dataset.cases.length);
const cases = dataset.cases.filter((c) => !only || c.id === only).slice(0, limit);

const { config, client } = setupOpenAi();
requireConsent(
  `Avaliacao real: ${cases.length} mensagens com ${config.modelFast}. Custo esperado: ~US$ ${(cases.length * 0.0003).toFixed(3)}.`,
);

const results: {
  id: string;
  kind: string;
  errors: (ErrorCategory | 'falha_da_api')[];
  output?: unknown;
}[] = [];
let totalCost = 0;
for (const evalCase of cases) {
  try {
    const result = await client.interpret({ text: evalCase.text, replyToText: null });
    totalCost += costUsd(result.usage, config.pricing);
    if (!result.ok) {
      results.push({
        id: evalCase.id,
        kind: evalCase.kind,
        errors: ['intencao'],
        output: result.reason,
      });
      continue;
    }
    const errors = compareInterpretation(evalCase.expect, result.value);
    results.push({ id: evalCase.id, kind: evalCase.kind, errors, output: result.value });
    console.log(
      `${errors.length === 0 ? '✅' : '❌'} ${evalCase.id}${errors.length ? ` — ${errors.join(', ')}` : ''}`,
    );
  } catch (error) {
    results.push({ id: evalCase.id, kind: evalCase.kind, errors: ['falha_da_api'] });
    console.log(`⚠️  ${evalCase.id} — ${explainAiError(error)}`);
  }
}

const passed = results.filter((r) => r.errors.length === 0).length;
const categories = new Map<string, number>();
for (const r of results) for (const e of r.errors) categories.set(e, (categories.get(e) ?? 0) + 1);
const byKind = new Map<string, [number, number]>();
for (const r of results) {
  const [ok, total] = byKind.get(r.kind) ?? [0, 0];
  byKind.set(r.kind, [ok + (r.errors.length === 0 ? 1 : 0), total + 1]);
}

console.log(
  `\nAcerto: ${passed}/${results.length} (${Math.round((passed * 100) / Math.max(results.length, 1))}%)`,
);
console.log(`Por tipo: ${[...byKind].map(([k, [ok, t]]) => `${k} ${ok}/${t}`).join(', ')}`);
console.log(`Erros: ${[...categories].map(([k, n]) => `${k} ${n}`).join(', ') || 'nenhum'}`);
console.log(`Custo estimado: US$ ${totalCost.toFixed(4)}`);

mkdirSync('evals/results', { recursive: true });
const file = `evals/results/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(
  file,
  JSON.stringify(
    {
      datasetVersion: dataset.version,
      model: config.modelFast,
      passed,
      total: results.length,
      categories: Object.fromEntries(categories),
      results,
    },
    null,
    2,
  ),
);
console.log(`Relatorio: ${file}`);
