import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { sql } from 'drizzle-orm';
import { bootstrapHousehold } from '../../src/application/commands/bootstrap';
import type { Deps } from '../../src/application/context';
import type { Bindings } from '../../src/config/env';
import { loadConfig } from '../../src/config/env';
import type { AiClient, AiResult, AiUsageSample } from '../../src/infrastructure/ai/client';
import type { Interpretation } from '../../src/infrastructure/ai/interpretation';
import { createDb } from '../../src/infrastructure/database/client';
import type { Meter } from '../../src/infrastructure/database/metered';
import { meterD1 } from '../../src/infrastructure/database/metered';
import type { MessagingGateway, OutgoingMessage } from '../../src/infrastructure/messaging/gateway';
import { createApp } from '../../src/interfaces/http/routes';

export const CHAT_ID = '-100200300';
export const OTHER_CHAT_ID = '-999';
export const FELIPE_ID = '1001';
export const JENNIFER_ID = '1002';
export const STRANGER_ID = '6666';
export const WEBHOOK_SECRET = 'test-webhook-secret';
export const ADMIN_TOKEN = 'test-admin-token';

/** 10/11/2026 12:00 em America/Maceio (UTC-3). */
export const DEFAULT_NOW = Date.UTC(2026, 10, 10, 15, 0, 0);

export class FakeMessaging implements MessagingGateway {
  meter: Meter = { count: 0 };
  sent: OutgoingMessage[] = [];
  failure: Error | null = null;
  acknowledged: string[] = [];

  async sendMessage(message: OutgoingMessage): Promise<void> {
    this.meter.count += 1;
    if (this.failure) throw this.failure;
    this.sent.push(message);
  }

  async acknowledgeButton(callbackId: string): Promise<void> {
    this.meter.count += 1;
    this.acknowledged.push(callbackId);
  }

  texts(): string[] {
    return this.sent.map((m) => m.text);
  }

  last(): string {
    return this.sent.at(-1)?.text ?? '';
  }
}

const usage = (operation: AiUsageSample['operation'] = 'interpret'): AiUsageSample => ({
  model: operation === 'interpret' ? 'gpt-6-luna' : 'gpt-6.1-terra',
  operation,
  inputTokens: 500,
  cachedInputTokens: 0,
  outputTokens: 100,
});

export class FakeAi implements AiClient {
  meter: Meter = { count: 0 };
  /** Executado durante a chamada, para simular eventos concorrentes. */
  duringCall: (() => Promise<void>) | null = null;
  calls: string[] = [];
  analysisCalls = 0;
  nextInterpretation: Interpretation | Error | { invalid: true } | null = null;
  analysisText: string | Error = 'Tudo sob controle.';

  async interpret(input: { text: string }): Promise<AiResult<Interpretation>> {
    this.meter.count += 1;
    this.calls.push(input.text);
    if (this.duringCall) await this.duringCall();
    const next = this.nextInterpretation;
    if (next instanceof Error) throw next;
    if (next && 'invalid' in next) return { ok: false, reason: 'invalid_output', usage: usage() };
    return { ok: true, value: next ?? interpretation('not_financial'), usage: usage() };
  }

  async writeAnalysis(): Promise<AiResult<string>> {
    this.meter.count += 1;
    this.analysisCalls += 1;
    if (this.analysisText instanceof Error) throw this.analysisText;
    return { ok: true, value: this.analysisText, usage: usage('analysis') };
  }
}

export function interpretation(
  intent: Interpretation['intent'],
  overrides: Partial<Interpretation> = {},
): Interpretation {
  return {
    intent,
    confidence: 'high',
    transactions: [],
    query: null,
    budget: null,
    goal: null,
    commitment: null,
    correction: null,
    purchase: null,
    ...overrides,
  };
}

export type Item = Interpretation['transactions'][number];

export function item(overrides: Partial<Item> & Pick<Item, 'amount_text' | 'description'>): Item {
  return {
    kind: 'expense',
    category_slug: null,
    person_text: null,
    is_shared: false,
    source_account_text: null,
    destination_account_text: null,
    date_text: null,
    payment_method: 'unknown',
    installments: null,
    ...overrides,
  };
}

const TABLES = [
  'budget_alerts',
  'installments',
  'recurring_settlements',
  'installment_plans',
  'balance_reconciliations',
  'goal_contributions',
  'financial_goals',
  'budgets',
  'recurring_entries',
  'financial_transactions',
  'pending_actions',
  'onboarding_sessions',
  'lease_guard',
  'audit_events',
  'ai_usage',
  'incoming_events',
  'outgoing_messages',
  'financial_accounts',
  'categories',
  'household_members',
  'households',
];

export interface Harness {
  deps: Deps;
  /** Deps com o medidor zerado, como numa invocacao nova do Cron. */
  fresh(): Deps;
  messaging: FakeMessaging;
  ai: FakeAi;
  setNow(value: number): void;
  now(): number;
  webhook(body: unknown, options?: { secret?: string | null; raw?: string }): Promise<Response>;
  admin(path: string, init?: RequestInit, token?: string | null): Promise<Response>;
  /** Envia uma mensagem de texto pelo webhook real e aguarda o processamento. */
  say(text: string, options?: SayOptions): Promise<Response>;
  press(data: string, from?: string): Promise<Response>;
  query<T>(statement: string, ...params: unknown[]): Promise<T[]>;
  count(table: string, where?: string): Promise<number>;
}

export interface SayOptions {
  from?: string;
  chat?: string;
  updateId?: number;
  messageId?: number;
  edited?: boolean;
  chatType?: string;
  replyToBot?: boolean;
}

let sequence = 1000;
const nextSequence = () => ++sequence;

export async function createHarness(
  options: { withAi?: boolean; bootstrap?: boolean } = {},
): Promise<Harness> {
  const bindings = env as unknown as Bindings;
  const meter: Meter = { count: 0 };
  const db = createDb(meterD1(bindings.DB, meter));
  for (const table of TABLES) {
    await db.run(sql.raw(`DELETE FROM ${table}`));
  }

  let clock = DEFAULT_NOW;
  const messaging = new FakeMessaging();
  const ai = new FakeAi();
  messaging.meter = meter;
  ai.meter = meter;
  const deps: Deps = {
    db,
    messaging,
    ai: options.withAi === false ? null : ai,
    config: loadConfig(bindings),
    now: () => clock,
    newId: () => crypto.randomUUID(),
    meter,
  };
  const app = createApp(() => deps);

  async function post(path: string, init: RequestInit): Promise<Response> {
    // Cada requisicao e uma invocacao nova: o medidor recomeca.
    meter.count = 0;
    const ctx = createExecutionContext();
    const response = await app.fetch(new Request(`https://otto.test${path}`, init), bindings, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }

  const webhook: Harness['webhook'] = (body, opts = {}) => {
    const secret = opts.secret === undefined ? WEBHOOK_SECRET : opts.secret;
    return post('/webhook/telegram', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(secret !== null && { 'x-telegram-bot-api-secret-token': secret }),
      },
      body: opts.raw ?? JSON.stringify(body),
    });
  };

  const harness: Harness = {
    deps,
    fresh: () => {
      meter.count = 0;
      return deps;
    },
    messaging,
    ai,
    setNow: (value) => {
      clock = value;
    },
    now: () => clock,
    webhook,
    admin: (path, init = {}, token = ADMIN_TOKEN) =>
      post(`/admin${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(token !== null && { authorization: `Bearer ${token}` }),
        },
      }),
    say: (text, opts = {}) => {
      const message = {
        message_id: opts.messageId ?? nextSequence(),
        date: Math.floor(clock / 1000),
        chat: { id: Number(opts.chat ?? CHAT_ID), type: opts.chatType ?? 'supergroup' },
        from: { id: Number(opts.from ?? FELIPE_ID), is_bot: false },
        text,
        ...(opts.replyToBot && {
          reply_to_message: { text: 'pergunta do bot', from: { id: 1, is_bot: true } },
        }),
      };
      return webhook({
        update_id: opts.updateId ?? nextSequence(),
        [opts.edited ? 'edited_message' : 'message']: message,
      });
    },
    press: (data, from = FELIPE_ID) =>
      webhook({
        update_id: nextSequence(),
        callback_query: {
          id: `cb-${nextSequence()}`,
          from: { id: Number(from), is_bot: false },
          data,
          message: {
            message_id: nextSequence(),
            date: Math.floor(clock / 1000),
            chat: { id: Number(CHAT_ID), type: 'supergroup' },
          },
        },
      }),
    query: async <T>(statement: string, ...params: unknown[]) => {
      const result = await bindings.DB.prepare(statement)
        .bind(...params)
        .all<T>();
      return result.results;
    },
    count: async (table, where = '1 = 1') => {
      const result = await bindings.DB.prepare(
        `SELECT count(*) AS total FROM ${table} WHERE ${where}`,
      ).first<{ total: number }>();
      return result?.total ?? 0;
    },
  };

  if (options.bootstrap !== false) {
    await bootstrapHousehold(deps, {
      householdName: 'Casa de Teste',
      timezone: 'America/Maceio',
      telegramChatId: CHAT_ID,
      members: [
        { name: 'Felipe', telegramUserId: FELIPE_ID, role: 'admin' },
        { name: 'Jennifer', telegramUserId: JENNIFER_ID, role: 'admin' },
      ],
    });
  }
  return harness;
}

export function buttonData(messaging: FakeMessaging, action: 'c' | 'x'): string {
  const buttons = messaging.sent.at(-1)?.buttons;
  const row = buttons?.[0];
  const data = row?.[action === 'c' ? 0 : 1]?.data;
  if (!data) throw new Error('mensagem sem botoes');
  return data;
}

export async function withAccounts(harness: Harness): Promise<void> {
  await harness.say('/addconta corrente Principal saldo=1000 padrao');
  await harness.say('/addconta reserva Reserva saldo=500');
  await harness.say('/addconta cartao Nubank fecha=3 vence=10');
}
