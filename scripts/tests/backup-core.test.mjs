import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertOutsideRepo,
  buildManifest,
  countRows,
  decrypt,
  encrypt,
  lastMigration,
} from '../backup-core.mjs';
import { parseJsonc } from '../lib.mjs';

const SQL = `PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE financial_transactions (id text);
INSERT INTO "financial_transactions" ("id") VALUES('a');
INSERT INTO "financial_transactions" ("id") VALUES('b');
INSERT INTO "households" ("id") VALUES('h');
INSERT INTO "d1_migrations" ("id","name") VALUES(1,'0000_sour_valeria_richards.sql');
INSERT INTO "d1_migrations" ("id","name") VALUES(2,'0001_silly_kree.sql');`;

test('criptografia ida e volta e senha errada falha', () => {
  const sealed = encrypt(Buffer.from(SQL), 'senha-bem-longa-123');
  assert.notEqual(sealed.toString('utf8').includes('financial_transactions'), true);
  assert.equal(decrypt(sealed, 'senha-bem-longa-123').toString('utf8'), SQL);
  assert.throws(() => decrypt(sealed, 'outra-senha-longa-123'), /Senha incorreta/);
});

test('senha curta e recusada', () => {
  assert.throws(() => encrypt(Buffer.from('x'), 'curta'), /pelo menos/);
});

test('arquivo adulterado e detectado', () => {
  const sealed = encrypt(Buffer.from(SQL), 'senha-bem-longa-123');
  sealed[sealed.length - 1] ^= 1;
  assert.throws(() => decrypt(sealed, 'senha-bem-longa-123'), /corrompido/);
});

test('manifesto conta linhas e identifica a ultima migracao', () => {
  assert.equal(countRows(SQL).financial_transactions, 2);
  assert.equal(countRows(SQL).households, 1);
  assert.equal(lastMigration(SQL), '0001_silly_kree.sql');
  const manifest = buildManifest({
    sql: SQL,
    environment: 'local',
    gitCommit: 'abc',
    encrypted: true,
    createdAt: 'x',
  });
  assert.equal(manifest.rows.financial_transactions, 2);
  assert.match(manifest.sha256, /^[0-9a-f]{64}$/);
});

test('backup nunca e gravado dentro do repositorio', () => {
  assert.throws(() => assertOutsideRepo('backups', process.cwd()), /dentro do repositorio/);
  assert.throws(() => assertOutsideRepo(process.cwd(), process.cwd()), /dentro do repositorio/);
  assert.doesNotThrow(() => assertOutsideRepo(join(homedir(), 'otto-backups'), process.cwd()));
});

test('leitura de JSONC respeita strings com barras e virgulas finais', () => {
  const parsed = parseJsonc('{\n // comentario\n "a": "http://x//y", "b": [1, 2,],\n}');
  assert.deepEqual(parsed, { a: 'http://x//y', b: [1, 2] });
});
