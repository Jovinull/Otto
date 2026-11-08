// Gera backup SQL do D1 e um export JSON dos dados financeiros em backups/.
// Uso: pnpm backup             (producao)
//      pnpm backup -- --local  (banco local do wrangler dev)
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isLocal, loadSettings } from './lib.mjs';

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const target = isLocal() ? 'local' : 'prod';
mkdirSync('backups', { recursive: true });
const sqlFile = `backups/otto-${target}-${stamp}.sql`;

const wranglerArgs = isLocal()
  ? ['d1', 'export', 'DB', '--local', '--persist-to', '.wrangler/state', '--output', sqlFile]
  : ['d1', 'export', 'DB', '--remote', '--env', 'production', '--output', sqlFile];
execFileSync('pnpm', ['exec', 'wrangler', ...wranglerArgs], { stdio: 'inherit', shell: true });
console.log(`SQL: ${sqlFile}`);

const settings = loadSettings();
if (settings.OTTO_BASE_URL && settings.ADMIN_API_TOKEN) {
  const response = await fetch(`${settings.OTTO_BASE_URL}/admin/export`, {
    headers: { authorization: `Bearer ${settings.ADMIN_API_TOKEN}` },
  });
  if (response.ok) {
    const jsonFile = `backups/otto-${target}-${stamp}.json`;
    writeFileSync(jsonFile, await response.text());
    console.log(`JSON: ${jsonFile}`);
  } else {
    console.log(`Export JSON ignorado (HTTP ${response.status}).`);
  }
}
console.log('Guarde os arquivos fora do repositorio, em local seguro: contem dados financeiros.');
