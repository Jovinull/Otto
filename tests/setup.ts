import type { D1Migration } from 'cloudflare:test';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll } from 'vitest';

beforeAll(async () => {
  const bindings = env as unknown as { DB: D1Database; TEST_MIGRATIONS: D1Migration[] };
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});
