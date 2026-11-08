// Configuracao compartilhada pelos scripts que chamam a OpenAI de verdade (smoke e avaliacao).
import type { Bindings } from '../src/config/env';
import { loadConfig } from '../src/config/env';
import type { AiUsageSample } from '../src/infrastructure/ai/client';
import { OpenAiClient } from '../src/infrastructure/ai/client';
import { estimateCostMicroUsd } from '../src/application/services/ai-governor';
import { RetryableError } from '../src/shared/errors';
import { readEnvFile, readWranglerConfig } from './lib.mjs';

export function setupOpenAi() {
  const env: Record<string, string | undefined> = { ...readEnvFile('.env'), ...process.env };
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error(
      'OPENAI_API_KEY ausente. Defina no .env local (nunca versionado) ou na sessao do terminal.',
    );
    process.exit(1);
  }
  const vars = readWranglerConfig().env.production.vars as Record<string, string>;
  const config = loadConfig({ ...vars, OPENAI_API_KEY: apiKey } as unknown as Bindings);
  return { config, client: new OpenAiClient(config, apiKey) };
}

export function requireConsent(plan: string): void {
  if (process.argv.includes('--yes')) return;
  console.log(plan);
  console.log('\nIsso consome creditos da OpenAI. Para executar, repita com --yes.');
  process.exit(2);
}

export function costUsd(
  usage: AiUsageSample,
  pricing: ReturnType<typeof setupOpenAi>['config']['pricing'],
): number {
  return estimateCostMicroUsd(usage, pricing) / 1_000_000;
}

/** Explica a falha sem expor chave nem URL. */
export function explainAiError(error: unknown): string {
  if (!(error instanceof RetryableError)) {
    return `Erro inesperado: ${error instanceof Error ? error.name : 'desconhecido'}`;
  }
  const detail = error.detail
    ? ` Detalhe da API: ${error.detail.replace(/sk-[\w-]+/g, 'sk-***')}`
    : '';
  const messages: Record<string, string> = {
    ai_rejected_401:
      'Chave invalida ou revogada (401). Gere outra em platform.openai.com/api-keys.',
    ai_rejected_403: 'Sem permissao para este modelo ou projeto (403). Confira o projeto da chave.',
    ai_rejected_404:
      'Modelo nao encontrado para esta conta (404). Confira OPENAI_MODEL_FAST/ANALYSIS.',
    ai_rejected_400: 'Requisicao recusada (400): schema, parametro ou modelo incompativel.',
    ai_rate_limited:
      'Limite de taxa ou creditos esgotados (429). Confira Billing e Limits no painel.',
    ai_timeout: 'Tempo esgotado (20 s). Tente de novo; se persistir, a API esta lenta.',
    ai_network: 'Falha de rede ao falar com a OpenAI.',
  };
  return `${messages[error.code] ?? `Falha da API (${error.code}).`}${detail}`;
}
