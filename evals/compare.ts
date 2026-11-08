import type { Interpretation } from '../src/infrastructure/ai/interpretation';
import { parseBRL } from '../src/shared/money';
import { normalizeText } from '../src/shared/text';

export interface Expectation {
  intents: string[];
  amounts?: (number | null)[];
  kinds?: string[];
  installments?: number[];
  person?: string;
  dates?: string[];
  correctionValue?: number;
  purchaseAmount?: number;
}

/** Categorias de erro usadas no relatorio da avaliacao. */
export type ErrorCategory =
  | 'intencao'
  | 'quantidade_de_lancamentos'
  | 'valor_errado'
  | 'valor_inventado'
  | 'valor_ausente'
  | 'tipo_de_lancamento'
  | 'parcelas'
  | 'pessoa'
  | 'data'
  | 'correcao'
  | 'valor_da_compra';

function cents(text: string | null): number | null {
  if (text === null) return null;
  const parsed = parseBRL(text);
  if (parsed.status === 'ok') return parsed.cents;
  if (parsed.status === 'ambiguous') return parsed.candidateCents;
  return -1;
}

const sortNumbers = (values: (number | null)[]) =>
  [...values].sort((a, b) => (a ?? -2) - (b ?? -2));

/** Compara a saida do modelo com o esperado. Lista vazia significa acerto. */
export function compareInterpretation(
  expected: Expectation,
  actual: Interpretation,
): ErrorCategory[] {
  const errors: ErrorCategory[] = [];
  if (!expected.intents.includes(actual.intent)) errors.push('intencao');

  if (expected.amounts) {
    const got = actual.transactions.map((t) => cents(t.amount_text));
    if (got.length !== expected.amounts.length) {
      errors.push('quantidade_de_lancamentos');
    } else {
      const want = sortNumbers(expected.amounts);
      const have = sortNumbers(got);
      want.forEach((value, i) => {
        if (value === have[i]) return;
        if (value === null) errors.push('valor_inventado');
        else if (have[i] === null) errors.push('valor_ausente');
        else errors.push('valor_errado');
      });
    }
  }
  if (expected.kinds) {
    const kinds = actual.transactions.map((t) => t.kind).sort();
    if (JSON.stringify(kinds) !== JSON.stringify([...expected.kinds].sort())) {
      errors.push('tipo_de_lancamento');
    }
  }
  if (expected.installments) {
    const got = actual.transactions.map((t) => t.installments ?? 1);
    if (JSON.stringify(got) !== JSON.stringify(expected.installments)) errors.push('parcelas');
  }
  if (expected.person) {
    const target = normalizeText(expected.person);
    const people = [
      ...actual.transactions.map((t) => t.person_text),
      actual.query?.person_text ?? null,
    ];
    if (!people.some((p) => p !== null && normalizeText(p).includes(target))) {
      errors.push('pessoa');
    }
  }
  if (expected.dates) {
    const dates = actual.transactions.map((t) => normalizeText(t.date_text ?? ''));
    if (!expected.dates.every((d) => dates.some((got) => got.includes(normalizeText(d))))) {
      errors.push('data');
    }
  }
  if (expected.correctionValue !== undefined) {
    if (cents(actual.correction?.value_text ?? null) !== expected.correctionValue) {
      errors.push('correcao');
    }
  }
  if (expected.purchaseAmount !== undefined) {
    if (cents(actual.purchase?.amount_text ?? null) !== expected.purchaseAmount) {
      errors.push('valor_da_compra');
    }
  }
  return [...new Set(errors)];
}
