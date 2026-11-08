import { auditEvents } from '../../infrastructure/database/schema';
import type { Stmt } from '../../infrastructure/database/client';
import type { Actor, Deps } from '../context';

/** Registro de auditoria: guarda apenas campos alterados, nunca o texto da mensagem. */
export function auditStatement(
  deps: Deps,
  actor: Actor,
  action: string,
  entityType: string,
  entityId: string,
  change: { before?: Record<string, unknown>; after?: Record<string, unknown> },
): Stmt {
  return deps.db.insert(auditEvents).values({
    id: deps.newId(),
    householdId: actor.scope.household.id,
    actorMemberId: actor.member.id,
    action,
    entityType,
    entityId,
    before: change.before ? JSON.stringify(change.before) : null,
    after: change.after ? JSON.stringify(change.after) : null,
    createdAt: deps.now(),
  });
}
