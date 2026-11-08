import { createScheduledController } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleScheduled, HOURLY_CRON } from '../../src/app';
import { deliverDueMessages, MAX_DELIVERY_ATTEMPTS } from '../../src/application/jobs/outbox';
import { runHourly, runRecovery } from '../../src/application/jobs/scheduled';
import { MAX_EVENT_ATTEMPTS, processEvent } from '../../src/application/services/inbox';
import type { Bindings } from '../../src/config/env';
import { loadConfig } from '../../src/config/env';
import { env } from 'cloudflare:workers';
import { OpenAiClient } from '../../src/infrastructure/ai/client';
import { TelegramClient } from '../../src/infrastructure/messaging/telegram/client';
import { PermanentError, RetryableError } from '../../src/shared/errors';
import type { Harness } from '../fixtures/harness';
import {
  CHAT_ID,
  createHarness,
  DEFAULT_NOW,
  FELIPE_ID,
  interpretation,
  item,
} from '../fixtures/harness';

let h: Harness;
const expense = () =>
  interpretation('register_expense', {
    transactions: [item({ amount_text: '27', description: 'Uber', category_slug: 'transporte' })],
  });

const advance = (ms: number) => h.setNow(h.now() + ms);
const HOUR = 3_600_000;
const eventStatus = async () =>
  (
    await h.query<{ status: string; attempts: number; last_error_code: string | null }>(
      'SELECT status, attempts, last_error_code FROM incoming_events',
    )
  )[0]!;

beforeEach(async () => {
  h = await createHarness();
});

describe('OpenAI indisponivel', () => {
  it('guarda o evento, avisa uma vez e processa depois sem perder a mensagem', async () => {
    h.ai.nextInterpretation = new RetryableError('ai_503');
    await h.say('Gastei 27 reais com Uber');
    expect(await h.count('financial_transactions')).toBe(0);
    expect((await eventStatus()).status).toBe('retry');
    expect(h.messaging.last()).toContain('Nada foi registrado ainda');

    advance(60_000);
    await runRecovery(h.deps);
    expect(h.messaging.sent).toHaveLength(1);

    h.ai.nextInterpretation = expense();
    advance(HOUR);
    await runRecovery(h.deps);
    expect(await h.count('financial_transactions')).toBe(1);
    expect((await eventStatus()).status).toBe('processed');
    expect(h.messaging.last()).toContain('R$ 27,00');
  });

  it('retentativa tardia usa a data original da mensagem', async () => {
    h.ai.nextInterpretation = new RetryableError('ai_503');
    await h.say('Gastei 27 reais com Uber');
    h.ai.nextInterpretation = expense();
    h.setNow(DEFAULT_NOW + 2 * 86_400_000);
    await runRecovery(h.deps);
    const [row] = await h.query<{ financial_date: string }>(
      'SELECT financial_date FROM financial_transactions',
    );
    expect(row!.financial_date).toBe('2026-11-10');
  });

  it('comandos deterministicos seguem funcionando sem IA', async () => {
    h = await createHarness({ withAi: false });
    await h.say('/gasto 27 Uber');
    await h.say('/resumo');
    expect(await h.count('financial_transactions')).toBe(1);
    expect(h.messaging.last()).toContain('R$ 27,00');
  });

  it('sem chave configurada a mensagem natural fica na fila', async () => {
    h = await createHarness({ withAi: false });
    await h.say('Gastei 27 reais com Uber');
    expect((await eventStatus()).status).toBe('retry');
    expect(await h.count('financial_transactions')).toBe(0);
  });

  it('timeout e retentado', async () => {
    h.ai.nextInterpretation = new RetryableError('ai_timeout');
    await h.say('gastei 27');
    expect(await eventStatus()).toMatchObject({ status: 'retry', last_error_code: 'ai_timeout' });
  });

  it('esgota tentativas em estado final e avisa que nada foi registrado', async () => {
    h.ai.nextInterpretation = new RetryableError('ai_503');
    await h.say('gastei 27');
    for (let i = 0; i < MAX_EVENT_ATTEMPTS + 1; i++) {
      advance(13 * HOUR);
      await runRecovery(h.deps);
    }
    expect((await eventStatus()).status).toBe('failed');
    expect(h.messaging.last()).toContain('nada foi registrado');
    expect(await h.count('financial_transactions')).toBe(0);
    const [event] = await h.query<{ payload: string | null }>(
      'SELECT payload FROM incoming_events',
    );
    expect(event!.payload).toBeNull();
  });
});

describe('resposta invalida do modelo', () => {
  it('nao registra e pede reformulacao quando chamado diretamente', async () => {
    h.ai.nextInterpretation = { invalid: true };
    await h.say('Otto, gastei 27');
    expect(await h.count('financial_transactions')).toBe(0);
    expect(h.messaging.last()).toContain('Nada foi registrado');
    expect((await eventStatus()).status).toBe('processed');
  });

  it('fica em silencio em conversa de grupo', async () => {
    h.ai.nextInterpretation = { invalid: true };
    await h.say('foram 2 vezes');
    expect(h.messaging.sent).toHaveLength(0);
  });

  it('classificacao ambigua nao vira lancamento', async () => {
    h.ai.nextInterpretation = interpretation('unknown');
    await h.say('Otto 27 aquilo lá');
    expect(await h.count('financial_transactions')).toBe(0);
    expect(h.messaging.last()).toContain('Não entendi');
  });

  it('cliente rejeita JSON fora do schema e detecta recusa', async () => {
    const config = loadConfig(env as unknown as Bindings);
    const respond = (body: unknown) => async () =>
      new Response(JSON.stringify(body), { status: 200 });
    const message = (content: unknown[]) => ({
      status: 'completed',
      output: [{ type: 'message', content }],
      usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 40 } },
    });

    const bad = new OpenAiClient(
      config,
      'k',
      respond(message([{ type: 'output_text', text: '{"intent":"hack"}' }])) as typeof fetch,
    );
    expect(await bad.interpret({ text: 'x', replyToText: null })).toMatchObject({
      ok: false,
      reason: 'invalid_output',
      usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 },
    });

    const refusal = new OpenAiClient(
      config,
      'k',
      respond(message([{ type: 'refusal', refusal: 'não' }])) as typeof fetch,
    );
    expect(await refusal.interpret({ text: 'x', replyToText: null })).toMatchObject({
      ok: false,
      reason: 'refusal',
    });

    const incomplete = new OpenAiClient(
      config,
      'k',
      respond({ status: 'incomplete', output: [] }) as typeof fetch,
    );
    expect(await incomplete.interpret({ text: 'x', replyToText: null })).toMatchObject({
      ok: false,
      reason: 'incomplete',
    });
  });

  it('cliente envia store false, formato estrito e nao vaza contexto', async () => {
    const config = loadConfig(env as unknown as Bindings);
    let sent: Record<string, unknown> = {};
    const fetcher = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ status: 'completed', output: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await new OpenAiClient(config, 'k', fetcher).interpret({
      text: 'gastei 10',
      replyToText: 'x'.repeat(1000),
    });
    expect(sent.store).toBe(false);
    expect(sent.model).toBe('gpt-6-luna');
    expect(sent.reasoning).toEqual({ effort: 'none' });
    expect((sent.text as { format: { strict: boolean } }).format.strict).toBe(true);
    const content = JSON.parse((sent.input as { content: string }[])[0]!.content);
    expect(content.respondendo_a).toHaveLength(300);
  });

  it('cliente classifica falhas de rede e HTTP', async () => {
    const config = loadConfig(env as unknown as Bindings);
    const failing = (fn: () => Promise<Response>) =>
      new OpenAiClient(config, 'k', fn as unknown as typeof fetch);
    await expect(
      failing(() => Promise.reject(new TypeError('x'))).interpret({ text: 'a', replyToText: null }),
    ).rejects.toMatchObject({ code: 'ai_network' });
    await expect(
      failing(() => Promise.reject(new DOMException('t', 'TimeoutError'))).interpret({
        text: 'a',
        replyToText: null,
      }),
    ).rejects.toMatchObject({ code: 'ai_timeout' });
    await expect(
      failing(async () => new Response('', { status: 500 })).interpret({
        text: 'a',
        replyToText: null,
      }),
    ).rejects.toBeInstanceOf(RetryableError);
    await expect(
      failing(async () => new Response('', { status: 401 })).interpret({
        text: 'a',
        replyToText: null,
      }),
    ).rejects.toMatchObject({ code: 'ai_rejected_401' });
  });
});

describe('Telegram indisponivel', () => {
  it('interrupcao apos persistir e antes de enviar nao duplica o lancamento', async () => {
    h.messaging.failure = new RetryableError('telegram_network');
    await h.say('/gasto 27 Uber');
    expect(await h.count('financial_transactions')).toBe(1);
    expect((await eventStatus()).status).toBe('processed');
    const [outbox] = await h.query<{ status: string; text: string }>(
      'SELECT status, text FROM outgoing_messages',
    );
    expect(outbox!.status).toBe('pending');
    expect(outbox!.text).toContain('R$ 27,00');

    h.messaging.failure = null;
    advance(HOUR);
    await runRecovery(h.deps);
    expect(await h.count('financial_transactions')).toBe(1);
    expect(h.messaging.sent).toHaveLength(1);
    expect(await h.count('outgoing_messages', "status = 'sent'")).toBe(1);
  });

  it('erro permanente encerra a entrega sem afetar o lancamento', async () => {
    h.messaging.failure = new PermanentError('telegram_403');
    await h.say('/gasto 27 Uber');
    expect(await h.count('outgoing_messages', "status = 'failed'")).toBe(1);
    expect(await h.count('financial_transactions')).toBe(1);
  });

  it('desiste apos o limite de tentativas', async () => {
    h.messaging.failure = new RetryableError('telegram_500');
    await h.say('/gasto 27 Uber');
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) {
      advance(3 * HOUR);
      await deliverDueMessages(h.deps, 5);
    }
    expect(await h.count('outgoing_messages', "status = 'failed'")).toBe(1);
  });

  it('retry_after do Telegram e respeitado', async () => {
    h.messaging.failure = new RetryableError('telegram_rate_limited', 120_000);
    await h.say('/gasto 27 Uber');
    const [row] = await h.query<{ next_attempt_at: number }>(
      'SELECT next_attempt_at FROM outgoing_messages',
    );
    expect(row!.next_attempt_at).toBe(h.now() + 120_000);
  });

  it('cliente nunca propaga a URL com o token em erro de rede', async () => {
    const client = new TelegramClient('SEGREDO', (() =>
      Promise.reject(new Error('https://x/botSEGREDO'))) as unknown as typeof fetch);
    const error = await client
      .sendMessage({ chatId: '1', text: 'a', replyToMessageId: null, buttons: null })
      .catch((e: Error) => e);
    expect((error as Error).message).toBe('telegram_network');
  });

  it('cliente mapeia 429, 5xx e 4xx e envia texto sem parse_mode', async () => {
    let body: Record<string, unknown> = {};
    const client = (status: number, json: unknown = {}) =>
      new TelegramClient('t', (async (_u: string, init: RequestInit) => {
        body = JSON.parse(init.body as string);
        return new Response(JSON.stringify(json), { status });
      }) as unknown as typeof fetch);
    const message = { chatId: '1', text: 'a', replyToMessageId: 5, buttons: null };
    await client(200, { ok: true }).sendMessage(message);
    expect(body.parse_mode).toBeUndefined();
    expect(body.reply_parameters).toEqual({ message_id: 5, allow_sending_without_reply: true });
    await expect(
      client(429, { parameters: { retry_after: 7 } }).sendMessage(message),
    ).rejects.toMatchObject({
      code: 'telegram_rate_limited',
      retryAfterMs: 7000,
    });
    await expect(client(502).sendMessage(message)).rejects.toBeInstanceOf(RetryableError);
    await expect(client(403).sendMessage(message)).rejects.toBeInstanceOf(PermanentError);
  });
});

describe('recuperacao de eventos', () => {
  it('retoma evento preso em processing depois do lease', async () => {
    const [household] = await h.query<{ id: string }>('SELECT id FROM households');
    await h.query(
      `INSERT INTO incoming_events (id, update_id, household_id, kind, chat_id, sender_telegram_id, message_id, message_date, payload, status, attempts, next_attempt_at, lease_until, received_at)
       VALUES (?, 4242, ?, 'message', ?, ?, 4242, ?, ?, 'processing', 1, 0, ?, ?)`,
      crypto.randomUUID(),
      household!.id,
      CHAT_ID,
      FELIPE_ID,
      Math.floor(h.now() / 1000),
      JSON.stringify({
        text: '/gasto 15 pão',
        replyToText: null,
        replyToBot: false,
        callbackId: null,
        callbackData: null,
      }),
      h.now() + 60_000,
      h.now(),
    );
    await runRecovery(h.deps);
    expect(await h.count('financial_transactions')).toBe(0);

    advance(61_000);
    await runRecovery(h.deps);
    expect(await h.count('financial_transactions')).toBe(1);
    expect(h.messaging.last()).toContain('R$ 15,00');
  });
  it('dois processadores concorrentes nao duplicam', async () => {
    h.messaging.failure = new RetryableError('telegram_network');
    await h.say('/gasto 27 Uber');
    const [event] = await h.query<{ id: string }>('SELECT id FROM incoming_events');
    await Promise.all([processEvent(h.deps, event!.id), processEvent(h.deps, event!.id)]);
    expect(await h.count('financial_transactions')).toBe(1);
  });

  it('erro temporario de banco nao deixa estado parcial', async () => {
    await h.say('/orcamento delivery 100');
    const realBatch = h.deps.db.batch.bind(h.deps.db);
    let shouldFail = true;
    h.deps.db.batch = ((statements: never) => {
      if (shouldFail && (statements as unknown[]).length >= 5) {
        shouldFail = false;
        return Promise.reject(new Error('D1_ERROR: temporary'));
      }
      return realBatch(statements);
    }) as typeof h.deps.db.batch;

    await h.say('/gasto 90 ifood');
    expect(await h.count('financial_transactions')).toBe(0);
    expect(await h.count('budget_alerts')).toBe(0);
    expect(await h.count('outgoing_messages', "text LIKE '%90,00%'")).toBe(0);
    expect(await h.count('incoming_events', "status = 'retry'")).toBe(1);

    advance(HOUR);
    await runRecovery(h.deps);
    expect(await h.count('financial_transactions')).toBe(1);
    expect(await h.count('budget_alerts')).toBe(1);
  });

  it('chave de idempotencia barra insercao repetida no proprio banco', async () => {
    await h.say('/gasto 27 Uber');
    const [row] = await h.query<{
      idempotency_key: string;
      household_id: string;
      member_id: string;
    }>('SELECT idempotency_key, household_id, member_id FROM financial_transactions');
    await expect(
      h.query(
        `INSERT INTO financial_transactions (id, household_id, type, amount_cents, description, member_id, created_by_member_id, financial_date, origin, idempotency_key, created_at, updated_at)
         VALUES ('dup', ?, 'expense', 100, 'x', ?, ?, '2026-11-10', 'command', ?, 0, 0)`,
        row!.household_id,
        row!.member_id,
        row!.member_id,
        row!.idempotency_key,
      ),
    ).rejects.toThrow(/UNIQUE/);
  });

  it('banco recusa movimentacoes invalidas', async () => {
    await h.say('/gasto 27 Uber');
    const [row] = await h.query<{ household_id: string; member_id: string }>(
      'SELECT household_id, member_id FROM financial_transactions',
    );
    const insert = (type: string, amount: number) =>
      h.query(
        `INSERT INTO financial_transactions (id, household_id, type, amount_cents, description, member_id, created_by_member_id, financial_date, origin, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'x', ?, ?, '2026-11-10', 'command', ?, 0, 0)`,
        crypto.randomUUID(),
        row!.household_id,
        type,
        amount,
        row!.member_id,
        row!.member_id,
        crypto.randomUUID(),
      );
    await expect(insert('expense', 0)).rejects.toThrow(/CHECK/);
    await expect(insert('expense', -5)).rejects.toThrow(/CHECK/);
    await expect(insert('transfer', 100)).rejects.toThrow(/CHECK/);
  });
});

describe('mensagens editadas', () => {
  it('nao altera lancamento e orienta uma unica vez', async () => {
    await h.say('/gasto 27 Uber', { messageId: 500 });
    const before = h.messaging.sent.length;
    await h.say('/gasto 99 Uber', { messageId: 500, edited: true });
    await h.say('/gasto 88 Uber', { messageId: 500, edited: true });
    const [row] = await h.query<{ amount_cents: number }>(
      'SELECT amount_cents FROM financial_transactions',
    );
    expect(row!.amount_cents).toBe(2700);
    expect(await h.count('financial_transactions')).toBe(1);
    expect(h.messaging.sent.length).toBe(before + 1);
    expect(h.messaging.last()).toContain('não altero lançamentos sozinho');
  });

  it('edicao de mensagem sem lancamento e ignorada', async () => {
    await h.say('bom dia', { messageId: 600 });
    await h.say('bom dia!', { messageId: 600, edited: true });
    expect(h.messaging.sent).toHaveLength(0);
  });
});

describe('limites de custo', () => {
  async function spend(microUsd: number) {
    await h.query(
      `INSERT INTO ai_usage (id, model, operation, estimated_cost_micro_usd, outcome, created_at) VALUES (?, 'gpt-6-luna', 'interpret', ?, 'ok', ?)`,
      crypto.randomUUID(),
      microUsd,
      h.now(),
    );
  }

  it('limite diario adia a chamada, avisa uma vez e preserva o registro', async () => {
    await spend(300_000);
    h.ai.nextInterpretation = expense();
    await h.say('Gastei 27 reais com Uber');
    expect(h.ai.calls).toHaveLength(0);
    expect((await eventStatus()).status).toBe('deferred');
    expect(h.messaging.last()).toContain('limite de uso de IA');

    await h.say('/gasto 10 pão');
    expect(await h.count('financial_transactions')).toBe(1);

    h.setNow(Date.UTC(2026, 10, 11, 0, 10));
    await runRecovery(h.deps);
    expect(h.ai.calls).toHaveLength(1);
    expect(await h.count('financial_transactions')).toBe(2);
  });

  it('nao consome tentativa enquanto adiado', async () => {
    await spend(300_000);
    await h.say('Gastei 27');
    expect((await eventStatus()).attempts).toBe(0);
  });

  it('limite mensal adia ate o mes seguinte', async () => {
    h.setNow(Date.UTC(2026, 10, 2, 15));
    await spend(3_000_000);
    h.setNow(Date.UTC(2026, 10, 10, 15));
    await h.say('Gastei 27');
    const [row] = await h.query<{ next_attempt_at: number; last_error_code: string }>(
      'SELECT next_attempt_at, last_error_code FROM incoming_events',
    );
    expect(row!.last_error_code).toBe('ai_budget_monthly');
    expect(row!.next_attempt_at).toBeGreaterThanOrEqual(Date.UTC(2026, 11, 1));
  });

  it('analise para antes do limite e cai no relatorio deterministico', async () => {
    await spend(250_000);
    h.ai.nextInterpretation = interpretation('request_analysis');
    await h.say('me dá uma análise');
    expect(h.ai.analysisCalls).toBe(0);
    expect(h.messaging.last()).toContain('números puros');
  });

  it('registra uso e custo estimado', async () => {
    h.ai.nextInterpretation = expense();
    await h.say('Gastei 27 reais com Uber');
    const [row] = await h.query<{
      model: string;
      estimated_cost_micro_usd: number;
      outcome: string;
    }>('SELECT model, estimated_cost_micro_usd, outcome FROM ai_usage');
    // 500 tokens de entrada x 0,10 + 100 de saida x 0,50 por milhao.
    expect(row).toEqual({ model: 'gpt-6-luna', estimated_cost_micro_usd: 100, outcome: 'ok' });
    await h.say('/ia');
    expect(h.messaging.last()).toContain('US$ 0.0001');
  });

  it('limita chamadas por membro por minuto', async () => {
    h.ai.nextInterpretation = expense();
    for (let i = 0; i < 11; i++) {
      await h.query(
        `INSERT INTO ai_usage (id, member_id, model, operation, outcome, created_at)
         SELECT ?, id, 'gpt-6-luna', 'interpret', 'ok', ? FROM household_members WHERE name = 'Felipe'`,
        crypto.randomUUID(),
        h.now(),
      );
    }
    await h.say('Gastei 27 reais');
    expect(h.ai.calls).toHaveLength(0);
    expect(await eventStatus()).toMatchObject({
      status: 'deferred',
      last_error_code: 'rate_limited',
    });
  });
});

describe('mensagens proativas', () => {
  // Segunda-feira 09/11/2026, 12:00 UTC = 09:00 em Maceio.
  const MONDAY_9AM = Date.UTC(2026, 10, 9, 12, 0);

  it('lembra contas no fuso local e nao repete', async () => {
    h.setNow(MONDAY_9AM);
    await h.say('/recorrente despesa 110 dia=12 internet');
    h.messaging.sent = [];
    await runHourly(h.deps, MONDAY_9AM);
    expect(h.messaging.last()).toContain('internet');
    const total = h.messaging.sent.length;
    await runHourly(h.deps, MONDAY_9AM + HOUR);
    expect(h.messaging.sent.length).toBe(total);
  });

  it('nao envia nada antes do horario local', async () => {
    const earlyUtc = Date.UTC(2026, 10, 9, 8, 0); // 05:00 em Maceio.
    h.setNow(earlyUtc);
    await h.say('/recorrente despesa 110 dia=12 internet');
    h.messaging.sent = [];
    await runHourly(h.deps, earlyUtc);
    expect(h.messaging.sent).toHaveLength(0);
  });

  it('conta paga nao gera lembrete', async () => {
    h.setNow(MONDAY_9AM);
    await h.say('/recorrente despesa 110 dia=12 internet');
    await h.say('/gasto 110 internet');
    h.messaging.sent = [];
    await runHourly(h.deps, MONDAY_9AM);
    expect(h.messaging.texts().join()).not.toContain('Contas chegando');
  });

  it('resumo semanal sai uma vez e so com dados', async () => {
    h.setNow(MONDAY_9AM);
    await runHourly(h.deps, MONDAY_9AM);
    expect(h.messaging.sent).toHaveLength(0);

    h.setNow(MONDAY_9AM - 3 * 86_400_000);
    await h.say('/gasto 50 mercado');
    h.setNow(MONDAY_9AM);
    h.messaging.sent = [];
    await runHourly(h.deps, MONDAY_9AM);
    await runHourly(h.deps, MONDAY_9AM + HOUR);
    const weekly = h.messaging.texts().filter((t) => t.includes('Semana de'));
    expect(weekly).toHaveLength(1);
    expect(weekly[0]).toContain('R$ 50,00');
  });

  it('fechamento mensal cobre o mes anterior uma vez', async () => {
    const dayOne = Date.UTC(2026, 11, 1, 12, 0);
    h.setNow(Date.UTC(2026, 10, 20, 15));
    await h.say('/gasto 200 mercado');
    h.setNow(dayOne);
    h.messaging.sent = [];
    await runHourly(h.deps, dayOne);
    await runHourly(h.deps, dayOne + HOUR);
    const closing = h.messaging.texts().filter((t) => t.includes('Fechamento de novembro/2026'));
    expect(closing).toHaveLength(1);
  });

  it('acompanhamento da meta no dia 15', async () => {
    const day15 = Date.UTC(2026, 10, 15, 12, 0);
    h.setNow(day15);
    await h.say('/meta entrada=80000');
    h.messaging.sent = [];
    await runHourly(h.deps, day15);
    expect(h.messaging.last()).toContain('Apartamento');
  });

  it('varredura registra alerta perdido sem duplicar com o alerta imediato', async () => {
    h.setNow(MONDAY_9AM);
    await h.say('/orcamento delivery 100');
    await h.say('/gasto 85 ifood');
    expect(await h.count('budget_alerts')).toBe(1);
    h.messaging.sent = [];
    await runHourly(h.deps, MONDAY_9AM);
    expect(h.messaging.texts().join()).not.toContain('Orçamento:');
    expect(await h.count('budget_alerts')).toBe(1);
  });

  it('notificacoes podem ser desativadas', async () => {
    h.setNow(MONDAY_9AM);
    await h.say('/recorrente despesa 110 dia=12 internet');
    await h.say('/notificacoes off');
    h.messaging.sent = [];
    await runHourly(h.deps, MONDAY_9AM);
    expect(h.messaging.sent).toHaveLength(0);
  });

  it('expira pendencias antigas e purga eventos fora da retencao', async () => {
    await h.say('/addconta corrente Alfa');
    await h.say('/addconta corrente Beta');
    await h.say('/gasto 30 padaria');
    expect(await h.count('pending_actions', "status = 'pending'")).toBe(1);

    const later = h.now() + 91 * 86_400_000;
    h.setNow(later);
    await runHourly(h.deps, later);
    expect(await h.count('pending_actions', "status = 'expired'")).toBe(1);
    expect(await h.count('incoming_events')).toBe(0);
    expect(await h.count('outgoing_messages')).toBe(0);
  });

  it('pendencia expirada nao executa', async () => {
    await h.say('/addconta corrente Alfa');
    await h.say('/addconta corrente Beta');
    await h.say('/gasto 30 padaria');
    advance(25 * HOUR);
    await h.say('beta');
    expect(await h.count('financial_transactions')).toBe(0);
  });

  it('roteia cron pelo identificador', async () => {
    const controller = createScheduledController({ cron: HOURLY_CRON, scheduledTime: MONDAY_9AM });
    await expect(
      handleScheduled(h.deps, controller.cron, controller.scheduledTime),
    ).resolves.toBeUndefined();
    await expect(handleScheduled(h.deps, '*/2 * * * *', MONDAY_9AM)).resolves.toBeUndefined();
  });
});
