import { and, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { isAuthorizedSender } from '../../domain/household/authorization';
import type { Db, Stmt } from '../../infrastructure/database/client';
import { commitAtomically } from '../../infrastructure/database/client';
import {
  householdMembers,
  households,
  incomingEvents,
  outgoingMessages,
} from '../../infrastructure/database/schema';
import type { InboundEvent, OutgoingMessage } from '../../infrastructure/messaging/gateway';
import { toLocalDate } from '../../shared/dates';
import { errorCode, logEvent, PermanentError, RetryableError } from '../../shared/errors';
import type { Actor, Deps, Effect, Reply, Scope } from '../context';
import { loadScope } from '../context';
import { findTransactionsByMessage, shortId } from '../queries/finance';
import { checkInterpretAllowance, isRateLimited, recordUsage } from './ai-governor';
import { handleCommand } from './command-router';
import { routeIntent } from './intent-router';
import { mentionsAssistant, shouldInterpret } from './message-filter';
import { handleButton, handlePendingReply } from './pending';
import { aiBudgetNotice, aiUnavailableNotice } from './tone';
import { deliverDueMessages } from '../jobs/outbox';

export const MAX_EVENT_ATTEMPTS = 9;
export const MAX_AI_TEXT_LENGTH = 800;
const LEASE_MS = 60_000;
const BACKOFF_MS = [
  30_000, 120_000, 600_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000, 43_200_000,
];

type EventRow = typeof incomingEvents.$inferSelect;

interface StoredPayload {
  text: string | null;
  replyToText: string | null;
  replyToBot: boolean;
  callbackId: string | null;
  callbackData: string | null;
}

export type IngestResult =
  | { status: 'stored'; eventId: string }
  | { status: 'duplicate' }
  | { status: 'ignored'; reason: string }
  | { status: 'identify'; message: OutgoingMessage };

async function findHouseholdByChat(db: Db, chatId: string) {
  const rows = await db
    .select()
    .from(households)
    .where(eq(households.telegramChatId, chatId))
    .limit(1);
  return rows[0] ?? null;
}

async function hasAnyHousehold(db: Db): Promise<boolean> {
  const rows = await db.select({ id: households.id }).from(households).limit(1);
  return rows.length > 0;
}

function identifyMessage(event: InboundEvent): OutgoingMessage {
  return {
    chatId: event.chatId,
    text: `Chat ID: ${event.chatId}\nSeu user ID: ${event.senderId}\nOtto ainda não foi configurado: nenhum dado financeiro é aceito.`,
    replyToMessageId: event.messageId,
    buttons: null,
  };
}

function isIdCommand(text: string | null): boolean {
  return text !== null && /^\/id(@\w+)?\s*$/i.test(text.trim());
}

/**
 * Persiste o evento antes de confirmar o recebimento ao Telegram.
 * Quem nao for autorizado nao gera nenhuma escrita no banco.
 */
export async function ingestEvent(deps: Deps, event: InboundEvent): Promise<IngestResult> {
  if (event.senderIsBot) return { status: 'ignored', reason: 'bot_sender' };

  const household = await findHouseholdByChat(deps.db, event.chatId);
  if (!household) {
    if (isIdCommand(event.text) && !(await hasAnyHousehold(deps.db))) {
      return { status: 'identify', message: identifyMessage(event) };
    }
    return { status: 'ignored', reason: 'unknown_chat' };
  }

  if (event.migrateToChatId) {
    await deps.db
      .update(households)
      .set({ telegramChatId: event.migrateToChatId })
      .where(eq(households.id, household.id));
    logEvent('info', 'chat_migrated');
    return { status: 'ignored', reason: 'chat_migrated' };
  }

  const members = await deps.db
    .select()
    .from(householdMembers)
    .where(
      and(
        eq(householdMembers.householdId, household.id),
        eq(householdMembers.telegramUserId, event.senderId),
      ),
    )
    .limit(1);
  if (!isAuthorizedSender(household.telegramChatId, event.chatId, members[0])) {
    return { status: 'ignored', reason: 'unauthorized_sender' };
  }
  if (event.kind !== 'callback_query' && event.text === null) {
    return { status: 'ignored', reason: 'no_text' };
  }

  const payload: StoredPayload = {
    text: event.text,
    replyToText: event.replyToText,
    replyToBot: event.replyToBot,
    callbackId: event.callbackId,
    callbackData: event.callbackData,
  };
  const eventId = deps.newId();
  const now = deps.now();
  const inserted = await deps.db
    .insert(incomingEvents)
    .values({
      id: eventId,
      updateId: event.updateId,
      householdId: household.id,
      kind: event.kind,
      chatId: event.chatId,
      senderTelegramId: event.senderId,
      messageId: event.messageId,
      messageDate: event.date,
      payload: JSON.stringify(payload),
      status: 'received',
      nextAttemptAt: now,
      receivedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: incomingEvents.id });
  return inserted.length === 0 ? { status: 'duplicate' } : { status: 'stored', eventId };
}

async function claimEvent(deps: Deps, eventId: string): Promise<EventRow | null> {
  const now = deps.now();
  const rows = await deps.db
    .update(incomingEvents)
    .set({
      status: 'processing',
      attempts: sql`${incomingEvents.attempts} + 1`,
      leaseUntil: now + LEASE_MS,
    })
    .where(
      and(
        eq(incomingEvents.id, eventId),
        lte(incomingEvents.nextAttemptAt, now),
        or(
          inArray(incomingEvents.status, ['received', 'retry', 'deferred']),
          and(eq(incomingEvents.status, 'processing'), lte(incomingEvents.leaseUntil, now)),
        ),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

function outboxStatements(
  deps: Deps,
  event: EventRow,
  replies: readonly Reply[],
  prefix = 'event',
): Stmt[] {
  return replies.map((reply, index) =>
    deps.db
      .insert(outgoingMessages)
      .values({
        id: deps.newId(),
        householdId: event.householdId,
        chatId: event.chatId,
        text: reply.text,
        replyToMessageId: event.kind === 'callback_query' ? null : event.messageId,
        replyMarkup: reply.buttons ? JSON.stringify(reply.buttons) : null,
        dedupKey: `${prefix}:${event.id}:${index}`,
        nextAttemptAt: deps.now(),
        createdAt: deps.now(),
      })
      .onConflictDoNothing(),
  );
}

function finalizeStatement(
  deps: Deps,
  eventId: string,
  status: 'processed' | 'ignored' | 'failed',
  code: string | null,
): Stmt {
  return deps.db
    .update(incomingEvents)
    .set({
      status,
      payload: null,
      leaseUntil: null,
      lastErrorCode: code,
      processedAt: deps.now(),
    })
    .where(eq(incomingEvents.id, eventId));
}

async function reschedule(
  deps: Deps,
  event: EventRow,
  options: {
    status: 'retry' | 'deferred';
    nextAttemptAt: number;
    code: string;
    notice: string | null;
    refundAttempt: boolean;
  },
): Promise<void> {
  const notify = options.notice !== null && !event.noticeSent;
  await commitAtomically(deps.db, [
    deps.db
      .update(incomingEvents)
      .set({
        status: options.status,
        nextAttemptAt: options.nextAttemptAt,
        leaseUntil: null,
        lastErrorCode: options.code,
        noticeSent: event.noticeSent || notify,
        ...(options.refundAttempt && { attempts: sql`${incomingEvents.attempts} - 1` }),
      })
      .where(eq(incomingEvents.id, event.id)),
    ...(notify ? outboxStatements(deps, event, [{ text: options.notice! }], 'notice') : []),
  ]);
}

class DeferProcessing extends RetryableError {
  constructor(
    readonly nextAttemptAt: number,
    code: string,
    readonly notice: string | null,
  ) {
    super(code);
  }
}

function backoffFor(attempts: number, hintMs?: number): number {
  const base = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]!;
  return Math.max(base, hintMs ?? 0);
}

function parseCommand(text: string): { command: string; args: string[] } | null {
  if (!text.startsWith('/')) return null;
  const [head, ...args] = text.trim().split(/\s+/);
  const command = head!.slice(1).split('@')[0]!.toLowerCase();
  return command ? { command, args } : null;
}

async function interpretWithAi(
  deps: Deps,
  actor: Actor,
  payload: StoredPayload,
  text: string,
  addressed: boolean,
): Promise<Effect> {
  if (text.length > MAX_AI_TEXT_LENGTH) {
    return addressed || shouldInterpret(text, false)
      ? {
          statements: [],
          replies: [{ text: 'Mensagem longa demais para eu analisar. Pode resumir?' }],
        }
      : { statements: [], replies: [] };
  }
  if (!deps.ai) {
    throw new RetryableError('ai_not_configured');
  }
  const allowance = await checkInterpretAllowance(deps);
  if (!allowance.allowed) {
    throw new DeferProcessing(allowance.retryAt, `ai_budget_${allowance.reason}`, aiBudgetNotice());
  }
  if (await isRateLimited(deps, actor.member.id)) {
    throw new DeferProcessing(deps.now() + 90_000, 'rate_limited', null);
  }

  const result = await deps.ai.interpret({
    text,
    replyToText: payload.replyToBot ? payload.replyToText : null,
  });
  await recordUsage(
    deps,
    actor.scope.household.id,
    actor.member.id,
    result.usage,
    result.ok ? 'ok' : result.reason,
  );
  if (!result.ok) {
    return addressed
      ? {
          statements: [],
          replies: [{ text: 'Não consegui entender essa. Pode reformular? Nada foi registrado.' }],
        }
      : { statements: [], replies: [] };
  }
  return routeIntent(deps, actor, result.value, text, addressed);
}

async function handleText(
  deps: Deps,
  actor: Actor,
  payload: StoredPayload,
  text: string,
): Promise<Effect> {
  const trimmed = text.trim();
  const command = parseCommand(trimmed);
  if (command) return handleCommand(deps, actor, command.command, command.args);

  const pending = await handlePendingReply(deps, actor, trimmed);
  if (pending) return pending;

  const addressed = payload.replyToBot || mentionsAssistant(trimmed);
  if (!shouldInterpret(trimmed, addressed)) return { statements: [], replies: [] };
  return interpretWithAi(deps, actor, payload, trimmed, addressed);
}

async function handleEdited(deps: Deps, actor: Actor, event: EventRow): Promise<Effect> {
  if (event.messageId === null) return { statements: [], replies: [] };
  const linked = await findTransactionsByMessage(
    deps.db,
    actor.scope.household.id,
    event.chatId,
    event.messageId,
  );
  if (linked.length === 0) return { statements: [], replies: [] };
  const codes = linked.map((t) => shortId(t.id)).join(', ');
  return {
    statements: [],
    replies: [
      {
        text: `Vi que você editou a mensagem, mas não altero lançamentos sozinho. Para ajustar: /corrigir ${shortId(linked[0]!.id)} valor 30,00 (ou categoria/data). Código(s): ${codes}.`,
      },
    ],
  };
}

async function dispatch(
  deps: Deps,
  event: EventRow,
  actor: Actor,
  payload: StoredPayload,
): Promise<Effect> {
  if (event.kind === 'edited_message') return handleEdited(deps, actor, event);
  if (event.kind === 'callback_query') {
    const match = /^pa:([cx]):([0-9a-f-]{36})$/.exec(payload.callbackData ?? '');
    if (!match) return { statements: [], replies: [] };
    return handleButton(deps, actor, match[1] as 'c' | 'x', match[2]!);
  }
  return handleText(deps, actor, payload, payload.text ?? '');
}

async function dedupEditedNotice(deps: Deps, event: EventRow, effect: Effect): Promise<Stmt[]> {
  if (event.kind !== 'edited_message' || effect.replies.length === 0) {
    return outboxStatements(deps, event, effect.replies);
  }
  // Varias edicoes da mesma mensagem geram no maximo um aviso.
  return [
    deps.db
      .insert(outgoingMessages)
      .values({
        id: deps.newId(),
        householdId: event.householdId,
        chatId: event.chatId,
        text: effect.replies[0]!.text,
        replyToMessageId: event.messageId,
        dedupKey: `edited:${event.chatId}:${event.messageId}`,
        nextAttemptAt: deps.now(),
        createdAt: deps.now(),
      })
      .onConflictDoNothing(),
  ];
}

async function resolveActor(deps: Deps, event: EventRow): Promise<Actor | null> {
  if (!event.householdId) return null;
  const scope: Scope | null = await loadScope(deps.db, event.householdId);
  if (!scope) return null;
  const member = scope.members.find((m) => m.telegramUserId === event.senderTelegramId);
  // Autoriza de novo no processamento: o acesso pode ter sido revogado apos o recebimento.
  if (!isAuthorizedSender(scope.household.telegramChatId, event.chatId, member)) return null;
  return {
    scope,
    member: member!,
    chatId: event.chatId,
    messageId: event.kind === 'callback_query' ? null : event.messageId,
    eventId: event.id,
    today: toLocalDate(event.messageDate * 1000, scope.household.timezone),
  };
}

function parseStored(event: EventRow): StoredPayload | null {
  if (!event.payload) return null;
  try {
    return JSON.parse(event.payload) as StoredPayload;
  } catch {
    return null;
  }
}

async function failEvent(deps: Deps, event: EventRow, code: string): Promise<void> {
  await commitAtomically(deps.db, [
    finalizeStatement(deps, event.id, 'failed', code),
    ...outboxStatements(
      deps,
      event,
      [{ text: 'Não consegui processar sua mensagem e nada foi registrado. Pode enviar de novo?' }],
      'failure',
    ),
  ]);
}

/**
 * Processa um evento com dono exclusivo (lease). Lancamentos, resposta no outbox e estado final
 * sao gravados na mesma transacao: uma retentativa nunca duplica o lancamento.
 */
export async function processEvent(deps: Deps, eventId: string): Promise<void> {
  const event = await claimEvent(deps, eventId);
  if (!event) return;

  if (event.attempts > MAX_EVENT_ATTEMPTS) {
    await failEvent(deps, event, 'max_attempts');
    return;
  }

  let actor: Actor | null = null;
  try {
    const payload = parseStored(event);
    actor = await resolveActor(deps, event);
    if (!payload || !actor) {
      await commitAtomically(deps.db, [
        finalizeStatement(deps, event.id, 'ignored', 'not_authorized'),
      ]);
      return;
    }

    const effect = await dispatch(deps, event, actor, payload);
    const replies = await dedupEditedNotice(deps, event, effect);
    await commitAtomically(deps.db, [
      ...effect.statements,
      ...replies,
      finalizeStatement(deps, event.id, 'processed', null),
    ]);
    if (payload.callbackId && deps.messaging) {
      await deps.messaging.acknowledgeButton(payload.callbackId).catch(() => undefined);
    }
  } catch (error) {
    const code = errorCode(error);
    logEvent('warn', 'event_processing_failed', { code, attempts: event.attempts });
    if (error instanceof DeferProcessing) {
      await reschedule(deps, event, {
        status: 'deferred',
        nextAttemptAt: error.nextAttemptAt,
        code,
        notice: error.notice,
        refundAttempt: true,
      });
    } else if (error instanceof PermanentError || event.attempts >= MAX_EVENT_ATTEMPTS) {
      await failEvent(deps, event, code);
    } else {
      const hint = error instanceof RetryableError ? error.retryAfterMs : undefined;
      const isAiFailure = code.startsWith('ai_');
      await reschedule(deps, event, {
        status: 'retry',
        nextAttemptAt: deps.now() + backoffFor(event.attempts, hint),
        code,
        notice: isAiFailure ? aiUnavailableNotice(actor?.scope.settings.tone ?? 'friendly') : null,
        refundAttempt: false,
      });
    }
  }
  await deliverDueMessages(deps, 5);
}

export async function findDueEvents(deps: Deps, limit: number): Promise<string[]> {
  const now = deps.now();
  const rows = await deps.db
    .select({ id: incomingEvents.id })
    .from(incomingEvents)
    .where(
      or(
        and(
          inArray(incomingEvents.status, ['received', 'retry', 'deferred']),
          lte(incomingEvents.nextAttemptAt, now),
        ),
        and(eq(incomingEvents.status, 'processing'), lte(incomingEvents.leaseUntil, now)),
      ),
    )
    .orderBy(incomingEvents.receivedAt)
    .limit(limit);
  return rows.map((row) => row.id);
}
