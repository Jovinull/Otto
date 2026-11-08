import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import * as z from 'zod';
import {
  bootstrapHousehold,
  BootstrapInput,
  eraseHousehold,
  exportHousehold,
} from '../../application/commands/bootstrap';
import type { Deps } from '../../application/context';
import { ingestEvent, processEvent } from '../../application/services/inbox';
import type { Bindings } from '../../config/env';
import { households, incomingEvents, outgoingMessages } from '../../infrastructure/database/schema';
import { TelegramUpdate, toInboundEvent } from '../../infrastructure/messaging/telegram/updates';
import { logEvent } from '../../shared/errors';

const MAX_BODY_BYTES = 64 * 1024;

export type DepsFactory = (env: Bindings) => Deps;

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/** Compara hashes em tempo constante: nao vaza tamanho nem prefixo do segredo. */
export async function safeEqual(received: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(received), digest(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}

async function isAdmin(deps: Deps, header: string | undefined): Promise<boolean> {
  if (!deps.config.adminApiToken || !header?.startsWith('Bearer ')) return false;
  return safeEqual(header.slice(7), deps.config.adminApiToken);
}

const EraseInput = z.strictObject({ confirmHouseholdName: z.string() });

export function createApp(createDeps: DepsFactory) {
  const app = new Hono<{ Bindings: Bindings }>();

  app.onError((error, c) => {
    logEvent('error', 'unhandled_error', { name: error.name });
    return c.json({ ok: false }, 500);
  });

  app.get('/health', async (c) => {
    const deps = createDeps(c.env);
    try {
      await deps.db.run(sql`select 1`);
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  app.post('/webhook/telegram', async (c) => {
    const deps = createDeps(c.env);
    const secret = deps.config.webhookSecret;
    const received = c.req.header('x-telegram-bot-api-secret-token');
    if (!secret || !received || !(await safeEqual(received, secret))) {
      return c.json({ ok: false }, 401);
    }

    const declared = Number(c.req.header('content-length') ?? '0');
    if (declared > MAX_BODY_BYTES) return c.json({ ok: false }, 413);
    const raw = await c.req.text();
    if (raw.length > MAX_BODY_BYTES) return c.json({ ok: false }, 413);

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ ok: false }, 400);
    }
    const parsed = TelegramUpdate.safeParse(body);
    if (!parsed.success) return c.json({ ok: false }, 400);

    const event = toInboundEvent(parsed.data);
    if (!event) return c.json({ ok: true });

    // Falha ao persistir devolve 500 para o Telegram reenviar o update.
    const result = await ingestEvent(deps, event);
    if (result.status === 'stored') {
      // Caminho rapido apenas: se o processo cair aqui, o cron retoma pelo inbox.
      c.executionCtx.waitUntil(
        processEvent(deps, result.eventId).catch((error: unknown) => {
          logEvent('error', 'fast_path_failed', {
            name: error instanceof Error ? error.name : 'unknown',
          });
        }),
      );
    } else if (result.status === 'identify' && deps.messaging) {
      const messaging = deps.messaging;
      c.executionCtx.waitUntil(messaging.sendMessage(result.message).catch(() => undefined));
    }
    return c.json({ ok: true });
  });

  const admin = new Hono<{ Bindings: Bindings }>();
  admin.use('*', async (c, next) => {
    if (!(await isAdmin(createDeps(c.env), c.req.header('authorization')))) {
      logEvent('warn', 'admin_auth_failed', { path: c.req.path });
      return c.json({ ok: false }, 401);
    }
    return next();
  });

  admin.post('/bootstrap', async (c) => {
    const body = await c.req.json().catch(() => null);
    const input = BootstrapInput.safeParse(body);
    if (!input.success) return c.json({ ok: false, error: 'invalid_input' }, 400);
    const result = await bootstrapHousehold(createDeps(c.env), input.data);
    if (result.status === 'created')
      return c.json({ ok: true, householdId: result.householdId }, 201);
    return c.json(
      { ok: false, error: result.status },
      result.status === 'already_bootstrapped' ? 409 : 400,
    );
  });

  admin.get('/status', async (c) => {
    const deps = createDeps(c.env);
    const [events, outbox] = await deps.db.batch([
      deps.db
        .select({ status: incomingEvents.status, count: sql<number>`count(*)` })
        .from(incomingEvents)
        .groupBy(incomingEvents.status),
      deps.db
        .select({ status: outgoingMessages.status, count: sql<number>`count(*)` })
        .from(outgoingMessages)
        .groupBy(outgoingMessages.status),
    ]);
    return c.json({ ok: true, events, outbox });
  });

  admin.get('/export', async (c) => {
    const deps = createDeps(c.env);
    if (!deps.config.allowExport) return c.json({ ok: false, error: 'export_disabled' }, 403);
    logEvent('warn', 'admin_export');
    const rows = await deps.db.select({ id: households.id }).from(households).limit(1);
    if (!rows[0]) return c.json({ ok: false, error: 'not_bootstrapped' }, 404);
    return c.json(await exportHousehold(deps, rows[0].id));
  });

  admin.post('/erase', async (c) => {
    const deps = createDeps(c.env);
    if (!deps.config.allowErase) return c.json({ ok: false, error: 'erase_disabled' }, 403);
    const input = EraseInput.safeParse(await c.req.json().catch(() => null));
    const rows = await deps.db.select().from(households).limit(1);
    if (!rows[0]) return c.json({ ok: false, error: 'not_bootstrapped' }, 404);
    if (!input.success || input.data.confirmHouseholdName !== rows[0].name) {
      return c.json({ ok: false, error: 'confirmation_mismatch' }, 400);
    }
    await eraseHousehold(deps, rows[0].id);
    logEvent('warn', 'household_erased');
    return c.json({ ok: true });
  });

  app.route('/admin', admin);
  return app;
}
