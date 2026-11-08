// Restaura um backup num D1 local isolado e confere as contagens com o manifesto.
// Nunca toca em producao nem no banco do `pnpm dev`.
// Uso: pnpm restore:test -- "<arquivo .sql ou .sql.enc>" [--export-sql "<destino.sql>"]
//      --export-sql grava o SQL ja reordenado (para restaurar num banco novo, ver docs).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertOutsideRepo, decrypt, KEY_TABLES, reorderDump, sha256 } from './backup-core.mjs';
import { readEnvFile, runWrangler } from './lib.mjs';

const argv = process.argv.slice(2).filter((a) => a !== '--');
const exportIndex = argv.indexOf('--export-sql');
const exportTarget = exportIndex >= 0 ? argv.splice(exportIndex, 2)[1] : null;
const file = argv[0];
if (!file || !existsSync(file)) {
  console.error('Informe o arquivo do backup: pnpm restore:test -- "<arquivo>"');
  process.exit(1);
}
const env = { ...readEnvFile('.env'), ...process.env };
const manifestFile = file.replace(/\.sql(\.enc)?$/, '.manifest.json');
const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : null;

const raw = readFileSync(file);
const sql = file.endsWith('.enc') ? decrypt(raw, env.OTTO_BACKUP_PASSPHRASE || '') : raw;
let failures = 0;
const check = (ok, label) => {
  if (!ok) failures += 1;
  console.log(`${ok ? '✅' : '❌'} ${label}`);
};

if (manifest)
  check(sha256(sql) === manifest.sha256, 'integridade (sha256 confere com o manifesto)');
else console.log('⚠️  manifesto nao encontrado: so a importacao sera verificada');

// Diretorio temporario proprio: --local + --persist-to isolado, nunca --remote.
const isolated = mkdtempSync(join(tmpdir(), 'otto-restore-'));
const sqlFile = join(isolated, 'restore.sql');
const restorable = reorderDump(sql.toString('utf8'));
writeFileSync(sqlFile, restorable);
const wrangler = (...args) =>
  runWrangler(['d1', 'execute', 'DB', '--local', '--persist-to', isolated, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

try {
  wrangler('--file', resolve(sqlFile));
  check(true, `importado num D1 local isolado (${isolated})`);
  // Uma linha com subconsultas: o D1 limita o numero de termos de UNION.
  const query = `SELECT ${KEY_TABLES.map((t) => `(SELECT count(*) FROM ${t}) AS ${t}`).join(', ')}`;
  const output = wrangler('--json', '--command', query);
  const restored = JSON.parse(output.slice(output.indexOf('[')))[0].results[0];
  for (const table of KEY_TABLES) {
    const expected = manifest?.rows?.[table];
    if (expected === undefined) console.log(`   ${table}: ${restored[table]}`);
    else check(restored[table] === expected, `${table}: ${restored[table]} (esperado ${expected})`);
  }
  const fk = wrangler('--json', '--command', 'PRAGMA foreign_key_check');
  check(JSON.parse(fk.slice(fk.indexOf('[')))[0].results.length === 0, 'integridade referencial');
} catch (error) {
  failures += 1;
  const output = `${error.stderr ?? ''}\n${error.stdout ?? ''}`;
  const reason = output.split('\n').find((line) => /error|no such|erro/i.test(line));
  console.log(`❌ falha na restauracao: ${reason?.trim() ?? error.message.split('\n')[0]}`);
} finally {
  rmSync(isolated, { recursive: true, force: true });
}
if (failures === 0 && exportTarget) {
  try {
    assertOutsideRepo(resolve(exportTarget, '..'), process.cwd());
    writeFileSync(exportTarget, restorable);
    console.log(`SQL reordenado gravado em ${exportTarget} (texto puro: apague depois de usar).`);
  } catch (error) {
    failures += 1;
    console.log(`❌ ${error.message}`);
  }
}
console.log(
  failures === 0 ? '\nRestauracao verificada.' : `\n${failures} verificacao(oes) falharam.`,
);
process.exitCode = failures === 0 ? 0 : 1;
