import { and, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { outgoingMessages } from '../../infrastructure/database/schema';
import type { InlineButton } from '../../infrastructure/messaging/gateway';
import { errorCode, logEvent, PermanentError, RetryableError } from '../../shared/errors';
import type { Deps } from '../context';
import { canDeliver } from '../../infrastructure/database/metered';

export const MAX_DELIVERY_ATTEMPTS = 8;
const LEASE_MS = 30_000;
const BACKOFF_MS = [15_000, 60_000, 300_000, 900_000, 1_800_000, 3_600_000, 7_200_000];

type OutgoingRow = typeof outgoingMessages.$inferSelect;

async function claim(deps: Deps, id: string): Promise<OutgoingRow | null> {
  const now = deps.now();
  const rows = await deps.db
    .update(outgoingMessages)
    .set({
      status: 'sending',
      attempts: sql`${outgoingMessages.attempts} + 1`,
      leaseUntil: now + LEASE_MS,
    })
    .where(
      and(
        eq(outgoingMessages.id, id),
        or(
          and(eq(outgoingMessages.status, 'pending'), lte(outgoingMessages.nextAttemptAt, now)),
          and(eq(outgoingMessages.status, 'sending'), lte(outgoingMessages.leaseUntil, now)),
        ),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

async function markTerminal(
  deps: Deps,
  id: string,
  status: 'sent' | 'failed',
  code: string | null,
): Promise<void> {
  await deps.db
    .update(outgoingMessages)
    .set({
      status,
      text: null,
      replyMarkup: null,
      leaseUntil: null,
      lastErrorCode: code,
      ...(status === 'sent' && { sentAt: deps.now() }),
    })
    .where(eq(outgoingMessages.id, id));
}

/**
 * Entrega as respostas pendentes. A entrega e pelo menos uma vez: se o processo cair depois do
 * Telegram aceitar e antes de marcar como enviada, a mensagem pode repetir. O lancamento nao.
 */
export async function deliverDueMessages(deps: Deps, limit: number): Promise<void> {
  if (!deps.messaging || !canDeliver(deps.meter)) return;
  const now = deps.now();
  const due = await deps.db
    .select({ id: outgoingMessages.id })
    .from(outgoingMessages)
    .where(
      or(
        and(
          inArray(outgoingMessages.status, ['pending']),
          lte(outgoingMessages.nextAttemptAt, now),
        ),
        and(eq(outgoingMessages.status, 'sending'), lte(outgoingMessages.leaseUntil, now)),
      ),
    )
    .orderBy(outgoingMessages.createdAt)
    .limit(limit);

  for (const { id } of due) {
    if (!canDeliver(deps.meter)) return;
    const row = await claim(deps, id);
    if (!row?.text) continue;
    try {
      await deps.messaging.sendMessage({
        chatId: row.chatId,
        text: row.text,
        replyToMessageId: row.replyToMessageId,
        buttons: row.replyMarkup ? (JSON.parse(row.replyMarkup) as InlineButton[][]) : null,
      });
      await markTerminal(deps, id, 'sent', null);
    } catch (error) {
      const code = errorCode(error);
      logEvent('warn', 'delivery_failed', { code, attempts: row.attempts });
      if (error instanceof PermanentError || row.attempts >= MAX_DELIVERY_ATTEMPTS) {
        await markTerminal(deps, id, 'failed', code);
        continue;
      }
      const hint = error instanceof RetryableError ? (error.retryAfterMs ?? 0) : 0;
      const backoff = BACKOFF_MS[Math.min(row.attempts - 1, BACKOFF_MS.length - 1)]!;
      await deps.db
        .update(outgoingMessages)
        .set({
          status: 'pending',
          nextAttemptAt: deps.now() + Math.max(backoff, hint),
          leaseUntil: null,
          lastErrorCode: code,
        })
        .where(eq(outgoingMessages.id, id));
    }
  }
}
