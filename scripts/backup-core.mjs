// Funcoes puras do backup: criptografia, manifesto e travas de seguranca.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { homedir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';

const MAGIC = Buffer.from('OTTOBK1');
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const MIN_PASSPHRASE_LENGTH = 12;

/** Tabelas cujas contagens entram no manifesto e sao conferidas na restauracao. */
export const KEY_TABLES = [
  'households',
  'household_members',
  'financial_accounts',
  'categories',
  'financial_transactions',
  'installment_plans',
  'installments',
  'budgets',
  'financial_goals',
  'goal_contributions',
  'recurring_entries',
  'audit_events',
];

export function defaultBackupDir() {
  return join(homedir(), 'otto-backups');
}

/** Impede que dados financeiros sejam gravados dentro do repositorio. */
export function assertOutsideRepo(dir, repoRoot) {
  const rel = relative(resolve(repoRoot), resolve(dir));
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error(
      `Diretorio de backup dentro do repositorio (${dir}). Use um caminho fora dele.`,
    );
  }
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** AES-256-GCM com chave derivada por scrypt. Formato: MAGIC | salt | iv | tag | dados. */
export function encrypt(plain, passphrase) {
  if (!passphrase || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Senha de backup precisa de pelo menos ${MIN_PASSPHRASE_LENGTH} caracteres.`);
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, SCRYPT);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), data]);
}

export function decrypt(sealed, passphrase) {
  if (!sealed.subarray(0, MAGIC.length).equals(MAGIC))
    throw new Error('Arquivo nao e um backup criptografado do Otto.');
  let offset = MAGIC.length;
  const salt = sealed.subarray(offset, (offset += 16));
  const iv = sealed.subarray(offset, (offset += 12));
  const tag = sealed.subarray(offset, (offset += 16));
  const key = scryptSync(passphrase, salt, 32, SCRYPT);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(sealed.subarray(offset)), decipher.final()]);
  } catch {
    throw new Error('Senha incorreta ou arquivo corrompido.');
  }
}

/** Conta as linhas inseridas por tabela num dump SQL do D1. */
export function countRows(sql) {
  const counts = Object.fromEntries(KEY_TABLES.map((t) => [t, 0]));
  const pattern = /^INSERT INTO "?([a-z_]+)"?/gm;
  for (const match of sql.matchAll(pattern)) {
    if (match[1] in counts) counts[match[1]] += 1;
  }
  return counts;
}

/** Ultima migracao registrada no dump (tabela d1_migrations). */
export function lastMigration(sql) {
  const names = [...sql.matchAll(/INSERT INTO "?d1_migrations"?[^;]*?'(\d{4}_[\w-]+\.sql)'/g)].map(
    (m) => m[1],
  );
  return names.sort().at(-1) ?? null;
}

export function buildManifest({ sql, environment, gitCommit, encrypted, createdAt }) {
  return {
    format: 'otto-backup/1',
    createdAt,
    environment,
    gitCommit,
    lastMigration: lastMigration(sql),
    sha256: sha256(Buffer.from(sql)),
    encrypted,
    rows: countRows(sql),
  };
}

const STATEMENT_START = /^(PRAGMA|CREATE|INSERT|DELETE|UPDATE|BEGIN|COMMIT|DROP|ALTER)\b/;

/**
 * O `d1 export` intercala CREATE TABLE e INSERT em ordem alfabetica, entao uma tabela filha
 * recebe linhas antes da tabela pai existir. Reordena: PRAGMA, tabelas, dados, indices.
 */
export function reorderDump(sql) {
  const statements = [];
  for (const line of sql.split(/\r?\n/)) {
    if (STATEMENT_START.test(line) || statements.length === 0) statements.push(line);
    else statements[statements.length - 1] += `\n${line}`;
  }
  const groups = { pragma: [], table: [], data: [], index: [], other: [] };
  for (const statement of statements) {
    if (!statement.trim()) continue;
    if (statement.startsWith('PRAGMA')) groups.pragma.push(statement);
    else if (/^CREATE TABLE/.test(statement)) groups.table.push(statement);
    else if (statement.startsWith('INSERT')) groups.data.push(statement);
    else if (/^CREATE (UNIQUE )?INDEX/.test(statement)) groups.index.push(statement);
    else groups.other.push(statement);
  }
  return [...groups.pragma, ...groups.table, ...groups.data, ...groups.index, ...groups.other].join(
    '\n',
  );
}
