import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          // Banco separado para testar migracoes sobre dados no formato antigo.
          d1Databases: ['MIGRATION_DB'],
          bindings: {
            TEST_MIGRATIONS: migrations,
            TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
            ADMIN_API_TOKEN: 'test-admin-token',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./tests/setup.ts'],
      include: ['tests/**/*.test.ts'],
    },
  };
});
