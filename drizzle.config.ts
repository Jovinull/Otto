import { defineConfig } from 'drizzle-kit';

// Somente geracao de SQL. As migracoes sao aplicadas pelo Wrangler,
// o que mantem separados os fluxos local e remoto.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/infrastructure/database/schema.ts',
  out: './migrations',
});
