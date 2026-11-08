/** Valores monetarios sao sempre inteiros em centavos. Nenhum calculo usa ponto flutuante. */

export const MAX_AMOUNT_CENTS = 100_000_000_00; // R$ 100 milhoes: acima disso e erro de digitacao.

export type ParsedAmount =
  | { status: 'ok'; cents: number }
  | { status: 'ambiguous'; candidateCents: number; reason: string }
  | { status: 'invalid'; reason: string };

const invalid = (reason: string): ParsedAmount => ({ status: 'invalid', reason });

function toCents(integerPart: string, fraction: string): number {
  return Number(integerPart) * 100 + Number(fraction.padEnd(2, '0'));
}

function bounded(cents: number): ParsedAmount {
  if (!Number.isSafeInteger(cents) || cents <= 0) return invalid('valor deve ser maior que zero');
  if (cents > MAX_AMOUNT_CENTS) return invalid('valor acima do limite aceito');
  return { status: 'ok', cents };
}

/**
 * Interpreta valores no padrao brasileiro.
 * Aceita: 25 | 25,50 | 25,5 | R$ 25,50 | 1.250,00 | 1.250 | 2 mil | 1,5 mil | 2k.
 * Sinaliza como ambiguo o que nao segue o padrao brasileiro: 12.50 e 1,250.
 */
export function parseBRL(input: string): ParsedAmount {
  let text = input
    .trim()
    .toLowerCase()
    .replace(/^r\$\s*/, '')
    .replace(/\s*(reais|real|conto|contos|pila|pilas)$/, '')
    .trim();

  let multiplier = 1;
  const thousand = /^(.+?)\s*(mil|k)$/.exec(text);
  if (thousand) {
    text = thousand[1]!.trim();
    multiplier = 1000;
  }
  if (text.length === 0 || text.length > 20) return invalid('valor nao reconhecido');
  if (text.startsWith('-')) return invalid('valor deve ser positivo');

  const apply = (cents: number) => bounded(cents * multiplier);

  // 1250 | 25
  if (/^\d+$/.test(text)) return apply(Number(text) * 100);
  // 25,5 | 25,50 | 1250,00
  let match = /^(\d+),(\d{1,2})$/.exec(text);
  if (match) return apply(toCents(match[1]!, match[2]!));
  // 1.250 | 1.250.000 | 1.250,00
  match = /^(\d{1,3}(?:\.\d{3})+)(?:,(\d{1,2}))?$/.exec(text);
  if (match) return apply(toCents(match[1]!.replaceAll('.', ''), match[2] ?? ''));
  // 12.50 | 1.5: ponto decimal fora do padrao brasileiro.
  match = /^(\d+)\.(\d{1,2})$/.exec(text);
  if (match) {
    const candidate = apply(toCents(match[1]!, match[2]!));
    if (candidate.status !== 'ok') return candidate;
    return { status: 'ambiguous', candidateCents: candidate.cents, reason: 'ponto como decimal' };
  }
  // 1,250: pode ser 1,25 ou 1.250.
  match = /^(\d+),(\d{3,})$/.exec(text);
  if (match) {
    const candidate = apply(Number(match[1]!) * 100 + Number(match[2]!.slice(0, 2)));
    if (candidate.status !== 'ok') return candidate;
    return { status: 'ambiguous', candidateCents: candidate.cents, reason: 'virgula com 3 casas' };
  }
  return invalid('valor nao reconhecido');
}

/** Formata centavos como BRL sem passar por ponto flutuante. */
export function formatBRL(cents: number): string {
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const reais = Math.trunc(absolute / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const fraction = (absolute % 100).toString().padStart(2, '0');
  return `${negative ? '-' : ''}R$ ${reais},${fraction}`;
}

/** Percentual inteiro truncado: 79,9% nao aparece como 80%. */
export function percentOf(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.floor((part * 100) / whole);
}

/** Divide o total em parcelas somando exatamente o total; as primeiras absorvem o resto. */
export function splitInstallments(totalCents: number, count: number): number[] {
  if (!Number.isInteger(totalCents) || totalCents <= 0) throw new RangeError('total invalido');
  if (!Number.isInteger(count) || count < 1 || count > 120)
    throw new RangeError('quantidade de parcelas invalida');
  const base = Math.floor(totalCents / count);
  const remainder = totalCents - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0));
}
