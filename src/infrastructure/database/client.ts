import type { BatchItem } from 'drizzle-orm/batch';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

export type Db = DrizzleD1Database<typeof schema>;
export type Stmt = BatchItem<'sqlite'>;

export function createDb(database: D1Database): Db {
  return drizzle(database, { schema });
}

/** Executa os comandos em uma unica transacao do D1: ou todos valem, ou nenhum. */
export async function commitAtomically(db: Db, statements: Stmt[]): Promise<void> {
  if (statements.length === 0) return;
  await db.batch(statements as [Stmt, ...Stmt[]]);
}
