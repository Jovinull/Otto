import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

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

/** Remove comentarios e virgulas finais de um JSONC, respeitando strings. */
export function parseJsonc(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      out += char;
      if (char === '\\') out += text[++i] ?? '';
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (char === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
    } else {
      out += char;
    }
  }
  let clean = '';
  inString = false;
  for (let i = 0; i < out.length; i++) {
    const char = out[i];
    if (inString) {
      clean += char;
      if (char === '\\') clean += out[++i] ?? '';
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      clean += char;
    } else if (char === ',' && /^\s*[}\]]/.test(out.slice(i + 1))) {
      continue;
    } else {
      clean += char;
    }
  }
  return JSON.parse(clean);
}

export function readWranglerConfig() {
  return parseJsonc(readFileSync('wrangler.jsonc', 'utf8'));
}

/** Mensagem segura de um erro de fetch: nunca inclui URL (que pode conter token). */
export function describeNetworkError(error) {
  const cause = error?.cause?.code ?? error?.code ?? error?.name ?? 'erro desconhecido';
  return `falha de rede (${cause})`;
}

/** Executa o Wrangler local pelo Node, sem shell (sem problemas de aspas ou injecao). */
export function runWrangler(args, options = {}) {
  const require = createRequire(import.meta.url);
  const bin = join(dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js');
  return execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8', ...options });
}
