import { existsSync, readFileSync } from 'node:fs';

/** Le um arquivo KEY=VALUE (.env ou .dev.vars) sem imprimir valores. */
export function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match && !line.trim().startsWith('#'))
      values[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
  }
  return values;
}

export function isLocal() {
  return process.argv.includes('--local');
}

/** Configuracao: --local usa .dev.vars e o wrangler dev; caso contrario .env e producao. */
export function loadSettings(forceLocal = false) {
  const env = { ...readEnvFile('.env'), ...process.env };
  if (forceLocal || isLocal()) {
    const dev = readEnvFile('.dev.vars');
    return { ...env, ...dev, OTTO_BASE_URL: env.OTTO_LOCAL_URL || 'http://127.0.0.1:8787' };
  }
  return env;
}

export function required(settings, keys) {
  const missing = keys.filter((key) => !settings[key]);
  if (missing.length > 0) {
    console.error(`Faltam variaveis: ${missing.join(', ')}. Veja .env.example.`);
    process.exit(1);
  }
}
