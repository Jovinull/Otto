import type { D1Migration } from 'cloudflare:test';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const bindings = env as unknown as { MIGRATION_DB: D1Database; TEST_MIGRATIONS: D1Migration[] };

/** Banco no formato de producao anterior (ate a migracao 0002), com dados legados. */
describe('migracao 0003 sobre dados existentes', () => {
  it('preserva tudo e define dono, identidade e padrao individual', async () => {
    const db = bindings.MIGRATION_DB;
    const all = bindings.TEST_MIGRATIONS;
    const legacy = all.filter((m) => /^000[0-2]_/.test(m.name));
    expect(legacy).toHaveLength(3);
    await applyD1Migrations(db, legacy);

    await db.batch([
      db.prepare(
        `INSERT INTO households (id,name,telegram_chat_id,created_at) VALUES ('h','Casa','-1',0)`,
      ),
      db.prepare(
        `INSERT INTO household_members (id,household_id,name,telegram_user_id,role,created_at) VALUES ('f','h','Felipe','1','admin',0),('j','h','Jennifer','2','admin',0)`,
      ),
      db.prepare(`INSERT INTO financial_accounts (id,household_id,name,normalized_name,kind,owner_member_id,opening_balance_cents,is_default,created_at) VALUES
        ('a1','h','Itau','itau','checking','f',100000,1,0),
        ('a2','h','Antiga','antiga','checking',NULL,5000,1,0),
        ('a3','h','Casa','casa','joint',NULL,NULL,1,0),
        ('a4','h','Roxo','roxo','credit_card','j',NULL,0,0)`),
      db.prepare(
        `INSERT INTO financial_goals (id,household_id,name,kind,entry_cents,planned_monthly_cents,created_at,updated_at) VALUES ('g','h','Apartamento','apartment',8000000,100000,0,0)`,
      ),
      db.prepare(
        `INSERT INTO goal_contributions (id,household_id,goal_id,amount_cents,direction,kind,contribution_date,member_id,idempotency_key,created_at) VALUES ('c1','h','g',300000,'in','initial','2026-10-01','f','k1',0),('c2','h','g',50000,'in','contribution','2026-11-01','j','k2',0)`,
      ),
      db.prepare(
        `INSERT INTO recurring_entries (id,household_id,kind,description,normalized_description,member_id,member_key,amount_cents,schedule_type,schedule_value,created_at) VALUES ('r','h','income','Salário','salario','f','f',420000,'monthly_day',5,0)`,
      ),
    ]);

    await applyD1Migrations(db, all);

    const accounts = (
      await db
        .prepare('SELECT * FROM financial_accounts ORDER BY id')
        .all<Record<string, unknown>>()
    ).results;
    expect(accounts.map((a) => [a.id, a.ownership, a.identity_key])).toEqual([
      ['a1', 'member', 'f|cash|itau'],
      ['a2', 'unassigned', 'unassigned|cash|antiga'],
      ['a3', 'shared', 'shared|cash|casa'],
      ['a4', 'member', 'j|card|roxo'],
    ]);
    expect(accounts.map((a) => a.opening_balance_cents)).toEqual([100000, 5000, null, null]);
    expect(accounts.find((a) => a.id === 'a3')!.shared_fallback).toBe(1);

    const members = (
      await db
        .prepare('SELECT id, preferences FROM household_members ORDER BY id')
        .all<{ id: string; preferences: string }>()
    ).results;
    expect(JSON.parse(members[0]!.preferences)).toEqual({ defaultAccountId: 'a1' });
    expect(JSON.parse(members[1]!.preferences)).toEqual({});

    const [goal] = (
      await db.prepare('SELECT * FROM financial_goals').all<Record<string, unknown>>()
    ).results;
    expect(goal).toMatchObject({
      name: 'Apartamento',
      normalized_name: 'apartamento',
      entry_cents: 8000000,
      planned_monthly_cents: 100000,
      status: 'active',
    });
    const contributions = (
      await db
        .prepare('SELECT id, amount_cents, kind, account_id FROM goal_contributions ORDER BY id')
        .all()
    ).results;
    expect(contributions).toEqual([
      { id: 'c1', amount_cents: 300000, kind: 'initial', account_id: null },
      { id: 'c2', amount_cents: 50000, kind: 'contribution', account_id: null },
    ]);
    const [income] = (
      await db.prepare('SELECT amount_cents, frequency, account_id FROM recurring_entries').all()
    ).results;
    expect(income).toEqual({ amount_cents: 420000, frequency: 'monthly', account_id: null });

    // Agora pessoas diferentes podem ter o mesmo nome, e o Worker anterior ainda consegue gravar.
    await db.batch([
      db.prepare(
        `INSERT INTO financial_accounts (id,household_id,name,normalized_name,kind,owner_member_id,ownership,identity_key,created_at) VALUES ('a5','h','Itau','itau','checking','j','member','j|cash|itau',0)`,
      ),
      db.prepare(
        `INSERT INTO financial_accounts (id,household_id,name,normalized_name,kind,created_at) VALUES ('a6','h','Velha 1','velha 1','checking',0),('a7','h','Velha 2','velha 2','checking',0)`,
      ),
    ]);
    await expect(
      db
        .prepare(
          `INSERT INTO financial_accounts (id,household_id,name,normalized_name,kind,identity_key,created_at) VALUES ('a8','h','Itau','itau','checking','f|cash|itau',0)`,
        )
        .run(),
    ).rejects.toThrow(/UNIQUE/);
  });
});
