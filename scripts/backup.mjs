// Backup do D1 para fora do repositorio, com manifesto e criptografia opcional.
// Uso: pnpm backup:prod            (producao, exige wrangler login)
//      pnpm backup:local           (banco local do wrangler dev)
// Variaveis (ambiente ou .env): OTTO_BACKUP_DIR, OTTO_BACKUP_PASSPHRASE, OTTO_BACKUP_KEEP
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertOutsideRepo, buildManifest, defaultBackupDir, encrypt } from './backup-core.mjs';
import { isLocal, readEnvFile, runWrangler } from './lib.mjs';

const env = { ...readEnvFile('.env'), ...process.env };
const target = isLocal() ? 'local' : 'prod';
const dir = env.OTTO_BACKUP_DIR || defaultBackupDir();
const passphrase = env.OTTO_BACKUP_PASSPHRASE || '';
const keep = Number(env.OTTO_BACKUP_KEEP || 0);

assertOutsideRepo(dir, process.cwd());
mkdirSync(dir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const base = `otto-${target}-${stamp}`;
const scratch = mkdtempSync(join(tmpdir(), 'otto-backup-'));
const plainFile = join(scratch, `${base}.sql`);

try {
  const args = isLocal()
    ? ['d1', 'export', 'DB', '--local', '--output', plainFile]
    : ['d1', 'export', 'DB', '--remote', '--env', 'production', '--output', plainFile];
  runWrangler(args, { stdio: 'inherit' });

  const sql = readFileSync(plainFile, 'utf8');
  let gitCommit = null;
  try {
    gitCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    gitCommit = null;
  }
  const manifest = buildManifest({
    sql,
    environment: target,
    gitCommit,
    encrypted: Boolean(passphrase),
    createdAt: new Date().toISOString(),
  });

  const dataFile = join(dir, passphrase ? `${base}.sql.enc` : `${base}.sql`);
  writeFileSync(dataFile, passphrase ? encrypt(Buffer.from(sql), passphrase) : sql);
  writeFileSync(join(dir, `${base}.manifest.json`), JSON.stringify(manifest, null, 2));

  console.log(`Backup: ${dataFile}`);
  console.log(
    `Linhas: ${Object.entries(manifest.rows)
      .map(([t, n]) => `${t}=${n}`)
      .join(', ')}`,
  );
  if (!passphrase) {
    console.log(
      'Aviso: sem OTTO_BACKUP_PASSPHRASE o arquivo fica em texto puro. Guarde em local protegido.',
    );
  }

  if (keep > 0) {
    const ours = readdirSync(dir)
      .filter((f) => f.startsWith(`otto-${target}-`) && f.endsWith('.manifest.json'))
      .sort();
    for (const old of ours.slice(0, Math.max(ours.length - keep, 0))) {
      const prefix = old.replace('.manifest.json', '');
      for (const f of readdirSync(dir).filter((name) => name.startsWith(prefix)))
        rmSync(join(dir, f));
      console.log(`Removido por retencao: ${prefix}`);
    }
  }
  console.log(`Teste a restauracao: pnpm restore:test -- "${dataFile}"`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
