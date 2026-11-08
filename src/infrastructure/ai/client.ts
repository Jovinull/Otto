import type { AppConfig } from '../../config/env';
import { RetryableError } from '../../shared/errors';
import { Interpretation, interpretationJsonSchema } from './interpretation';
import { ANALYSIS_INSTRUCTIONS, INTERPRET_INSTRUCTIONS } from './prompts';

export interface AiUsageSample {
  /** Modelo pedido (base do custo estimado). */
  model: string;
  /** Modelo informado pela API na resposta (pode ser um snapshot datado). */
  servedModel?: string | null;
  operation: 'interpret' | 'analysis';
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export type AiResult<T> =
  | { ok: true; value: T; usage: AiUsageSample }
  | { ok: false; reason: 'refusal' | 'incomplete' | 'invalid_output'; usage: AiUsageSample };

export interface InterpretInput {
  text: string;
  /** Mensagem anterior a que o usuario respondeu: unico contexto recente enviado. */
  replyToText: string | null;
}

export interface AiClient {
  interpret(input: InterpretInput): Promise<AiResult<Interpretation>>;
  writeAnalysis(facts: Record<string, unknown>, question: string): Promise<AiResult<string>>;
}

const TIMEOUT_MS = 20_000;
const MAX_REPLY_CONTEXT = 300;

interface ResponsesPayload {
  model?: string;
  status?: string;
  output?: { type: string; content?: { type: string; text?: string }[] }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
}

interface CallOptions {
  model: string;
  operation: AiUsageSample['operation'];
  instructions: string;
  input: string;
  maxOutputTokens: number;
  effort: 'none' | 'low';
  format?: Record<string, unknown>;
}

type RawResult =
  | { ok: true; text: string; usage: AiUsageSample }
  | { ok: false; reason: 'refusal' | 'incomplete'; usage: AiUsageSample };

export class OpenAiClient implements AiClient {
  constructor(
    private readonly config: AppConfig,
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
  ) {}

  async interpret(input: InterpretInput): Promise<AiResult<Interpretation>> {
    const result = await this.call({
      model: this.config.modelFast,
      operation: 'interpret',
      instructions: INTERPRET_INSTRUCTIONS,
      // Serializado como dado, separado das instrucoes.
      input: JSON.stringify({
        mensagem: input.text,
        respondendo_a: input.replyToText?.slice(0, MAX_REPLY_CONTEXT) ?? null,
      }),
      maxOutputTokens: 800,
      effort: 'none',
      format: {
        type: 'json_schema',
        name: 'interpretation',
        strict: true,
        schema: interpretationJsonSchema(),
      },
    });
    if (!result.ok) return result;
    try {
      const parsed = Interpretation.safeParse(JSON.parse(result.text));
      if (parsed.success) return { ok: true, value: parsed.data, usage: result.usage };
    } catch {
      // JSON invalido segue para o retorno abaixo.
    }
    return { ok: false, reason: 'invalid_output', usage: result.usage };
  }

  async writeAnalysis(facts: Record<string, unknown>, question: string): Promise<AiResult<string>> {
    const result = await this.call({
      model: this.config.modelAnalysis,
      operation: 'analysis',
      instructions: ANALYSIS_INSTRUCTIONS,
      input: JSON.stringify({ pergunta: question.slice(0, 500), fatos: facts }),
      maxOutputTokens: 1500,
      effort: 'low',
    });
    if (!result.ok) return result;
    return { ok: true, value: result.text, usage: result.usage };
  }

  private async call(options: CallOptions): Promise<RawResult> {
    let response: Response;
    try {
      response = await this.fetcher('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: options.model,
          instructions: options.instructions,
          input: [{ role: 'user', content: options.input }],
          store: false,
          max_output_tokens: options.maxOutputTokens,
          reasoning: { effort: options.effort },
          ...(options.format && { text: { format: options.format } }),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === 'TimeoutError';
      throw new RetryableError(isTimeout ? 'ai_timeout' : 'ai_network');
    }
    if (!response.ok) {
      const detail = await response
        .json<{ error?: { message?: string } }>()
        .then((body) => body.error?.message?.slice(0, 300))
        .catch(() => undefined);
      // 401/403/404 sao configuracao errada, nao culpa da mensagem: ela fica na fila.
      if (response.status === 429) throw new RetryableError('ai_rate_limited', undefined, detail);
      if (response.status >= 500) {
        throw new RetryableError(`ai_${response.status}`, undefined, detail);
      }
      throw new RetryableError(`ai_rejected_${response.status}`, undefined, detail);
    }
    const payload = await response.json<ResponsesPayload>().catch(() => null);
    if (!payload) throw new RetryableError('ai_bad_gateway_body');

    const usage: AiUsageSample = {
      model: options.model,
      servedModel: payload.model ?? null,
      operation: options.operation,
      inputTokens: payload.usage?.input_tokens ?? 0,
      cachedInputTokens: payload.usage?.input_tokens_details?.cached_tokens ?? 0,
      outputTokens: payload.usage?.output_tokens ?? 0,
    };
    if (payload.status === 'incomplete') return { ok: false, reason: 'incomplete', usage };

    const parts = (payload.output ?? [])
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? []);
    if (parts.some((part) => part.type === 'refusal')) {
      return { ok: false, reason: 'refusal', usage };
    }
    const text = parts
      .filter((part) => part.type === 'output_text')
      .map((part) => part.text ?? '')
      .join('');
    if (!text) return { ok: false, reason: 'incomplete', usage };
    return { ok: true, text, usage };
  }
}
