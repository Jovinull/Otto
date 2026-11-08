// Teste real e opcional da OpenAI. Nao toca em banco nem em dados de producao.
// Uso: pnpm smoke:openai -- --yes            (interpretacao, ~US$ 0,0003)
//      pnpm smoke:openai -- --yes --analysis (inclui analise, ~US$ 0,01)
import { isGrounded } from '../src/application/services/advisor';
import { amountAppearsInText } from '../src/domain/finance/transactions';
import { parseBRL } from '../src/shared/money';
import { costUsd, explainAiError, requireConsent, setupOpenAi } from './openai-common';

const MESSAGE = 'Gastei 38,50 na farmácia ontem e 12 no estacionamento';
const EXPECTED_CENTS = [1200, 3850];

const { config, client } = setupOpenAi();
const withAnalysis = process.argv.includes('--analysis');
requireConsent(
  [
    'Smoke test da OpenAI:',
    `- interpretacao com ${config.modelFast} da frase ficticia "${MESSAGE}"`,
    withAnalysis ? `- analise curta com ${config.modelAnalysis} sobre fatos ficticios` : '',
  ]
    .filter(Boolean)
    .join('\n'),
);

let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
};

try {
  const result = await client.interpret({ text: MESSAGE, replyToText: null });
  const usage = result.usage;
  check(
    (usage.servedModel ?? '').startsWith(config.modelFast),
    'modelo de extracao',
    `pedido ${config.modelFast}, servido ${usage.servedModel ?? 'nao informado'}`,
  );
  check(result.ok, 'saida estruturada valida', result.ok ? '' : `motivo: ${result.reason}`);
  if (result.ok) {
    const value = result.value;
    check(value.intent === 'register_expense', 'intencao', value.intent);
    const cents = value.transactions
      .map((t) => {
        const parsed = parseBRL(t.amount_text ?? '');
        return parsed.status === 'ok' ? parsed.cents : null;
      })
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    check(
      JSON.stringify(cents) === JSON.stringify(EXPECTED_CENTS),
      'valores em centavos',
      JSON.stringify(cents),
    );
    check(
      value.transactions.every((t) => amountAppearsInText(t.amount_text, MESSAGE)),
      'valores presentes na mensagem',
    );
    check(
      value.transactions.some((t) => (t.date_text ?? '').toLowerCase().includes('ontem')),
      'data relativa preservada',
    );
  }
  check(
    usage.inputTokens > 0 && usage.outputTokens > 0,
    'consumo de tokens informado',
    `${usage.inputTokens} entrada (${usage.cachedInputTokens} em cache), ${usage.outputTokens} saida`,
  );
  console.log(`   custo estimado: US$ ${costUsd(usage, config.pricing).toFixed(6)}`);

  if (withAnalysis) {
    const facts = {
      periodo: '2026-11',
      despesas: 'R$ 1.230,00',
      por_categoria: [{ categoria: 'Delivery', total: 'R$ 230,00', participacao: '18%' }],
    };
    const analysis = await client.writeAnalysis(facts, 'Como estamos neste mês?');
    check(
      (analysis.usage.servedModel ?? '').startsWith(config.modelAnalysis),
      'modelo de analise',
      `pedido ${config.modelAnalysis}, servido ${analysis.usage.servedModel ?? 'nao informado'}`,
    );
    check(analysis.ok, 'analise gerada', analysis.ok ? '' : analysis.reason);
    if (analysis.ok) {
      check(
        isGrounded(analysis.value, new Set([123000, 23000]), new Set([18])),
        'analise usa somente numeros fornecidos',
      );
    }
    console.log(
      `   custo estimado da analise: US$ ${costUsd(analysis.usage, config.pricing).toFixed(6)}`,
    );
  }
} catch (error) {
  failures += 1;
  console.log(`❌ ${explainAiError(error)}`);
}

console.log(failures === 0 ? '\nOpenAI OK.' : `\n${failures} verificacao(oes) falharam.`);
process.exitCode = failures === 0 ? 0 : 1;
