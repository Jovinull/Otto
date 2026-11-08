import type { BudgetView } from '../queries/finance';
import { OVER_LIMIT_THRESHOLD } from '../../domain/budgets/budget';
import type { Tone } from '../../domain/household/settings';
import { formatBRL } from '../../shared/money';
import { stableHash } from '../../shared/text';

/** Texto escolhido de forma deterministica por semente, para nao soar repetitivo. */
function pick(options: readonly string[], seed: string): string {
  return options[stableHash(seed) % options.length]!;
}

export function registeredOpener(tone: Tone, seed: string): string {
  if (tone === 'friendly') return pick(['Anotado', 'Feito', 'Tá na conta', 'Registrado'], seed);
  return 'Registrado';
}

const PERCENT_TO_MENTION = 70;

/** Observacao sobre o orcamento apos um gasto. Numeros vem sempre do calculo no backend. */
export function budgetNudge(view: BudgetView, tone: Tone, seed: string): string | null {
  const { status } = view;
  if (status.percentUsed < PERCENT_TO_MENTION) return null;
  const scope = view.categoryId ? 'dessa categoria' : 'geral do mês';

  if (status.isOver) {
    const over = formatBRL(-status.remainingCents);
    if (tone === 'neutral') return `Orçamento ${scope} ultrapassado em ${over}.`;
    if (tone === 'firm') {
      return `Passaram ${over} do orçamento ${scope}. Melhor fechar essa torneira até o mês virar.`;
    }
    return pick(
      [
        `Opa, o orçamento ${scope} estourou em ${over}. 🫣 Dá para compensar em outra categoria?`,
        `Passou ${over} do orçamento ${scope}. Sem drama, mas vale segurar daqui para frente.`,
      ],
      seed,
    );
  }
  const used = `${status.percentUsed}%`;
  const left = formatBRL(status.remainingCents);
  if (tone === 'neutral') return `Uso do orçamento ${scope}: ${used}. Restam ${left}.`;
  if (tone === 'firm') return `Já foi ${used} do orçamento ${scope}. Sobram ${left}. Atenção.`;
  return pick(
    [
      `👀 Vocês já usaram ${used} do orçamento ${scope}. Sobram ${left}; vale segurar um pouco.`,
      `De olho: ${used} do orçamento ${scope} já foi. Ainda restam ${left}.`,
    ],
    seed,
  );
}

export function thresholdLabel(threshold: number): string {
  return threshold === OVER_LIMIT_THRESHOLD ? 'ultrapassado' : `${threshold}% atingido`;
}

export function aiUnavailableNotice(tone: Tone): string {
  const base =
    'Recebi sua mensagem, mas não consegui interpretá-la agora. Nada foi registrado ainda; tento de novo sozinho.';
  const hint = 'Se tiver pressa: /gasto 25,50 mercado funciona sem IA.';
  return tone === 'friendly' ? `⏳ ${base} ${hint}` : `${base} ${hint}`;
}

export function aiBudgetNotice(): string {
  return 'Atingi o limite de uso de IA definido por vocês. Sua mensagem ficou guardada e será processada quando o limite renovar. Nada foi registrado ainda. Comandos como /gasto continuam funcionando.';
}
