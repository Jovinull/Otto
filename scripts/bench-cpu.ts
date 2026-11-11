// Mede o tempo de CPU do nosso codigo por evento, descontando o tempo dentro do SQLite
// (que no D1 roda fora do Worker e nao conta no limite de 10 ms do plano gratuito).
// Uso: pnpm bench:cpu
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { bootstrapHousehold } from '../src/application/commands/bootstrap';
import type { Deps } from '../src/application/context';
import { runHourly } from '../src/application/jobs/scheduled';
import { ingestEvent, processEvent } from '../src/application/services/inbox';
import { loadConfig, type Bindings } from '../src/config/env';
import type { AiClient } from '../src/infrastructure/ai/client';
import type { Interpretation } from '../src/infrastructure/ai/interpretation';
import { createDb } from '../src/infrastructure/database/client';
import type { MessagingGateway } from '../src/infrastructure/messaging/gateway';
import { TelegramUpdate, toInboundEvent } from '../src/infrastructure/messaging/telegram/updates';
import { readWranglerConfig } from './lib.mjs';

// Tudo aqui e sincrono (node:sqlite, fakes sem rede): tempo de relogio ~ tempo de CPU.
// process.cpuUsage tem granularidade de ~15 ms no Windows, por isso performance.now().
let sqliteMs = 0;
const timed = <T>(fn: () => T): T => {
  const start = performance.now();
  try {
    return fn();
  } finally {
    sqliteMs += performance.now() - start;
  }
};

const normalize = (values: unknown[]) =>
  values.map((v) => (typeof v === 'boolean' ? Number(v) : v === undefined ? null : v)) as never[];

function fakeD1(db: DatabaseSync): D1Database {
  const statement = (sql: string, params: unknown[] = []) => {
    const prepare = (): StatementSync => timed(() => db.prepare(sql));
    const self = {
      sql,
      params,
      bind: (...values: unknown[]) => statement(sql, values),
      all: async () => {
        const rows = timed(() => prepare().all(...normalize(params)));
        return { results: rows, success: true, meta: {} };
      },
      raw: async () => {
        const stmt = prepare();
        stmt.setReturnArrays(true);
        return timed(() => stmt.all(...normalize(params)));
      },
      first: async () => timed(() => prepare().get(...normalize(params))) ?? null,
      run: async () => {
        const stmt = prepare();
        if (/returning/i.test(sql)) {
          const rows = timed(() => stmt.all(...normalize(params)));
          return { results: rows, success: true, meta: { changes: rows.length } };
        }
        const info = timed(() => stmt.run(...normalize(params)));
        return { results: [], success: true, meta: { changes: Number(info.changes) } };
      },
    };
    return self;
  };
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (stmts: ReturnType<typeof statement>[]) => {
      timed(() => db.exec('BEGIN'));
      try {
        const results = [];
        for (const s of stmts) {
          const stmt = timed(() => db.prepare(s.sql));
          const isRead = /^\s*select/i.test(s.sql) || /returning/i.test(s.sql);
          if (isRead) {
            stmt.setReturnArrays(false);
            results.push({
              results: timed(() => stmt.all(...normalize(s.params))),
              success: true,
              meta: {},
            });
          } else {
            const info = timed(() => stmt.run(...normalize(s.params)));
            results.push({ results: [], success: true, meta: { changes: Number(info.changes) } });
          }
        }
        timed(() => db.exec('COMMIT'));
        return results;
      } catch (error) {
        timed(() => db.exec('ROLLBACK'));
        throw error;
      }
    },
    exec: async (sql: string) => timed(() => db.exec(sql)),
  } as unknown as D1Database;
}

const sqlite = new DatabaseSync(':memory:');
for (const file of readdirSync('migrations')
  .filter((f) => f.endsWith('.sql'))
  .sort()) {
  for (const part of readFileSync(`migrations/${file}`, 'utf8').split('--> statement-breakpoint')) {
    if (part.trim()) sqlite.exec(part);
  }
}

let clock = Date.UTC(2026, 10, 10, 15);
let nextInterpretation: Interpretation | null = null;
const messaging: MessagingGateway = {
  sendMessage: async () => {},
  acknowledgeButton: async () => {},
};
const usage = {
  model: 'gpt-6-luna',
  operation: 'interpret' as const,
  inputTokens: 1,
  cachedInputTokens: 0,
  outputTokens: 1,
};
const ai: AiClient = {
  interpret: async () => ({ ok: true, value: nextInterpretation!, usage }),
  writeAnalysis: async () => ({
    ok: true,
    value: 'Tudo certo.',
    usage: { ...usage, operation: 'analysis' },
  }),
};
const vars = readWranglerConfig().env.production.vars;
const deps: Deps = {
  db: createDb(fakeD1(sqlite)),
  messaging,
  ai,
  config: loadConfig({ ...vars, TELEGRAM_WEBHOOK_SECRET: 'x' } as unknown as Bindings),
  now: () => clock,
  newId: () => crypto.randomUUID(),
  meter: { count: 0 },
};

let update = 1;
const tx = (amount: string, description: string) => ({
  kind: 'expense' as const,
  amount_text: amount,
  description,
  category_slug: null,
  person_text: null,
  is_shared: false,
  source_account_text: null,
  destination_account_text: null,
  date_text: null,
  payment_method: 'unknown' as const,
  installments: null,
});
const empty = {
  transactions: [],
  query: null,
  budget: null,
  goal: null,
  commitment: null,
  correction: null,
  purchase: null,
  invoice: null,
  help_topic: null,
  confidence: 'high' as const,
};

async function send(text: string): Promise<number> {
  clock += 10 * 60_000;
  const parsed = TelegramUpdate.parse({
    update_id: update++,
    message: {
      message_id: update,
      date: Math.floor(clock / 1000),
      chat: { id: -100, type: 'supergroup' },
      from: { id: 1 },
      text,
    },
  });
  sqliteMs = 0;
  deps.meter.count = 0;
  const start = performance.now();
  const result = await ingestEvent(deps, toInboundEvent(parsed)!);
  if (result.status === 'stored') await processEvent(deps, result.eventId);
  return performance.now() - start - sqliteMs;
}

await bootstrapHousehold(deps, {
  householdName: 'Bench',
  timezone: 'America/Maceio',
  telegramChatId: '-100',
  members: [
    { name: 'Ana', telegramUserId: '1', role: 'admin' },
    { name: 'Bia', telegramUserId: '2', role: 'admin' },
  ],
});
for (const setup of [
  '/addconta corrente Principal saldo=1000 padrao',
  '/addconta cartao Nubank fecha=3 vence=10',
  '/orcamento transporte 300',
  '/recorrente despesa 1200 dia=5 aluguel',
  '/meta entrada=80000 aporte=1000',
]) {
  await send(setup);
}
// Volume de um mes de uso para as consultas nao rodarem sobre tabelas vazias.
for (let i = 0; i < 120; i++) await send(`/gasto ${10 + (i % 50)} item${i % 15}`);

const scenarios: [string, () => Promise<number>][] = [
  ['/gasto (comando)', () => send('/gasto 27 uber')],
  ['/resumo', () => send('/resumo')],
  ['/contas', () => send('/contas')],
  [
    'IA: 2 despesas',
    () => {
      nextInterpretation = {
        ...empty,
        intent: 'register_expense',
        transactions: [tx('20', 'almoço'), tx('15', 'estacionamento')],
      };
      return send('gastei 20 no almoço e 15 no estacionamento');
    },
  ],
  [
    'IA: consulta de compra',
    () => {
      nextInterpretation = {
        ...empty,
        intent: 'consult_purchase',
        purchase: { amount_text: '90', description: 'pizza', category_slug: 'delivery' },
      };
      return send('podemos pedir pizza de 90?');
    },
  ],
  [
    'IA: analise',
    () => {
      nextInterpretation = { ...empty, intent: 'request_analysis' };
      return send('me da uma analise do mes');
    },
  ],
];

const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]!;
console.log('CPU do codigo da aplicacao por invocacao (ms), sem o tempo do SQLite:');
for (const [name, run] of scenarios) {
  const samples: number[] = [];
  for (let i = 0; i < 25; i++) samples.push(await run());
  console.log(
    `  ${name.padEnd(24)} 1a execucao ${samples[0]!.toFixed(2)} · mediana ${percentile(samples, 0.5).toFixed(2)} · p95 ${percentile(samples, 0.95).toFixed(2)}`,
  );
}
sqliteMs = 0;
const start = performance.now();
await runHourly(deps, Date.UTC(2026, 10, 9, 12));
console.log(`  ${'Cron horario'.padEnd(24)} ${(performance.now() - start - sqliteMs).toFixed(2)}`);
console.log('Limite do plano gratuito: 10 ms. Node e workerd usam V8; a medida e uma estimativa.');
