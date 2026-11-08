import { and, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { AppConfig } from '../config/env';
import type { LedgerContext } from '../domain/finance/transactions';
import type { HouseholdSettings } from '../domain/household/settings';
import { parseHouseholdSettings, parseMemberPreferences } from '../domain/household/settings';
import type { AiClient } from '../infrastructure/ai/client';
import type { Db, Stmt } from '../infrastructure/database/client';
import type { Meter } from '../infrastructure/database/metered';
import {
  categories,
  financialAccounts,
  householdMembers,
  households,
  pendingActions,
} from '../infrastructure/database/schema';
import type { InlineButton, MessagingGateway } from '../infrastructure/messaging/gateway';
import type { LocalDate } from '../shared/dates';

export interface Deps {
  db: Db;
  messaging: MessagingGateway | null;
  ai: AiClient | null;
  config: AppConfig;
  now: () => number;
  newId: () => string;
  /** Subrequisicoes ja feitas nesta invocacao (D1 + fetch). */
  meter: Meter;
}

export type Household = typeof households.$inferSelect;
export type Member = typeof householdMembers.$inferSelect;
export type Account = typeof financialAccounts.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type PendingAction = typeof pendingActions.$inferSelect;

/** Tudo que define o escopo de um Household. Consultas sempre filtram por household.id. */
export interface Scope {
  household: Household;
  settings: HouseholdSettings;
  members: Member[];
  accounts: Account[];
  categories: Category[];
}

export interface Actor {
  scope: Scope;
  member: Member;
  chatId: string;
  messageId: number | null;
  eventId: string;
  /** Data local no momento em que a mensagem foi enviada. */
  today: LocalDate;
  /** Confirmacao ou pergunta mais recente do remetente, ainda valida. */
  latestPending: PendingAction | null;
}

export interface Reply {
  text: string;
  buttons?: InlineButton[][];
}

/** Resultado de um caso de uso: gravacoes e respostas confirmadas na mesma transacao. */
export interface Effect {
  statements: Stmt[];
  replies: Reply[];
}

export const replyOnly = (text: string, buttons?: InlineButton[][]): Effect => ({
  statements: [],
  replies: [buttons ? { text, buttons } : { text }],
});

function scopeQueries(db: Db, householdId: string) {
  return [
    db.select().from(households).where(eq(households.id, householdId)),
    db.select().from(householdMembers).where(eq(householdMembers.householdId, householdId)),
    db
      .select()
      .from(financialAccounts)
      .where(
        and(eq(financialAccounts.householdId, householdId), isNull(financialAccounts.archivedAt)),
      ),
    db
      .select()
      .from(categories)
      .where(and(eq(categories.householdId, householdId), isNull(categories.archivedAt))),
  ] as const;
}

function buildScope([householdRows, memberRows, accountRows, categoryRows]: readonly [
  Household[],
  Member[],
  Account[],
  Category[],
]): Scope | null {
  const household = householdRows[0];
  if (!household) return null;
  return {
    household,
    settings: parseHouseholdSettings(household.settings),
    members: memberRows,
    accounts: accountRows,
    categories: categoryRows,
  };
}

export async function loadScope(db: Db, householdId: string): Promise<Scope | null> {
  return buildScope(await db.batch(scopeQueries(db, householdId)));
}

/** Escopo e pendencia do remetente numa unica chamada ao banco. */
export async function loadScopeWithPending(
  db: Db,
  householdId: string,
  senderTelegramId: string,
  now: number,
): Promise<{ scope: Scope | null; latestPending: PendingAction | null }> {
  const [householdRows, memberRows, accountRows, categoryRows, pendingRows] = await db.batch([
    ...scopeQueries(db, householdId),
    db
      .select()
      .from(pendingActions)
      .where(
        and(
          eq(pendingActions.householdId, householdId),
          eq(pendingActions.status, 'pending'),
          gt(pendingActions.expiresAt, now),
          inArray(
            pendingActions.memberId,
            db
              .select({ id: householdMembers.id })
              .from(householdMembers)
              .where(
                and(
                  eq(householdMembers.householdId, householdId),
                  eq(householdMembers.telegramUserId, senderTelegramId),
                ),
              ),
          ),
        ),
      )
      .orderBy(desc(pendingActions.createdAt))
      .limit(1),
  ]);
  return {
    scope: buildScope([householdRows, memberRows, accountRows, categoryRows]),
    latestPending: pendingRows[0] ?? null,
  };
}

export function ledgerContext(actor: Actor): LedgerContext {
  const { scope } = actor;
  return {
    members: scope.members
      .filter((m) => m.status === 'active')
      .map((m) => ({
        id: m.id,
        name: m.name,
        defaultAccountId: parseMemberPreferences(m.preferences).defaultAccountId,
      })),
    accounts: scope.accounts,
    categories: scope.categories,
    senderMemberId: actor.member.id,
    today: actor.today,
  };
}
