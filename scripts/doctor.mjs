// Diagnostico geral do projeto. Nao imprime valores de segredos e nao altera nada.
// Uso: pnpm doctor              (verificacoes locais)
//      pnpm doctor -- --remote  (inclui Cloudflare: login, migracoes, segredos e /health)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describeNetworkError, readEnvFile, readWranglerConfig, runWrangler } from './lib.mjs';

const remote = process.argv.includes('--remote');
let failures = 0;
let warnings = 0;
const ok = (label) => console.log(`✅ ${label}`);
const warn = (label, fix) => {
  warnings += 1;
  console.log(`⚠️  ${label}\n   → ${fix}`);
};
const fail = (label, fix) => {
  failures += 1;
  console.log(`❌ ${label}\n   → ${fix}`);
};
const section = (title) => console.log(`\n— ${title}`);
const wrangler = (args) => runWrangler(args, { stdio: ['ignore', 'pipe', 'pipe'] });

section('Ambiente');
const major = Number(process.versions.node.split('.')[0]);
if (major >= 22) ok(`Node ${process.versions.node}`);
else fail(`Node ${process.versions.node}`, 'Instale Node 22 ou superior.');
if (existsSync('node_modules/wrangler')) ok('Dependencias instaladas');
else fail('Dependencias ausentes', 'Rode pnpm install.');

section('Configuracao do Worker (wrangler.jsonc)');
let config = null;
try {
  config = readWranglerConfig();
  ok('wrangler.jsonc valido');
} catch (error) {
  fail(`wrangler.jsonc invalido (${error.message})`, 'Corrija a sintaxe do arquivo.');
}
if (config) {
  const production = config.env?.production;
  if (config.workers_dev === false) ok('Ambiente padrao nao publica (somente local)');
  else warn('Ambiente padrao pode publicar', 'Mantenha workers_dev: false fora de env.production.');
  const databaseId = production?.d1_databases?.[0]?.database_id ?? '';
  if (/^[0-9a-f-]{36}$/.test(databaseId) && !databaseId.startsWith('00000000')) {
    ok('Banco de producao configurado');
  } else {
    fail(
      'database_id de producao nao configurado',
      'Rode wrangler d1 create otto-prod e copie o id para env.production em wrangler.jsonc.',
    );
  }
  const crons = production?.triggers?.crons ?? [];
  if (crons.includes('0 * * * *') && crons.length >= 2 && crons.length <= 5)
    ok(`Cron Triggers: ${crons.join(', ')}`);
  else fail(`Cron Triggers inesperados: ${crons.join(', ')}`, 'Restaure os crons do repositorio.');
  try {
    const pricing = JSON.parse(production.vars.OPENAI_PRICING_JSON);
    const models = [production.vars.OPENAI_MODEL_FAST, production.vars.OPENAI_MODEL_ANALYSIS];
    if (models.every((m) => pricing[m])) ok(`Precos configurados para ${models.join(' e ')}`);
    else
      fail('Tabela de precos sem algum modelo', 'Atualize OPENAI_PRICING_JSON em wrangler.jsonc.');
  } catch {
    fail('OPENAI_PRICING_JSON invalido', 'Corrija o JSON em wrangler.jsonc.');
  }
  if (
    production?.vars?.ADMIN_ALLOW_ERASE === 'true' ||
    production?.vars?.ADMIN_ALLOW_EXPORT === 'true'
  ) {
    warn(
      'Exportacao ou exclusao pelo endpoint admin habilitada',
      'Mantenha ADMIN_ALLOW_ERASE/EXPORT ausentes, exceto durante o uso; depois faca deploy de novo.',
    );
  } else {
    ok('Exportacao e exclusao por HTTP desabilitadas');
  }
}
if (
  existsSync('src/worker-configuration.d.ts') &&
  readFileSync('src/worker-configuration.d.ts', 'utf8').includes('DB: D1Database')
) {
  ok('Tipos dos bindings gerados (DB)');
} else {
  warn('Tipos dos bindings ausentes ou desatualizados', 'Rode pnpm types.');
}

section('Segredos e arquivos locais');
try {
  const tracked = execFileSync('git', ['ls-files', '.env', '.dev.vars', '*.pem', 'backups'], {
    encoding: 'utf8',
  }).trim();
  if (tracked)
    fail(
      `Arquivos sensiveis versionados: ${tracked}`,
      'git rm --cached nesses arquivos e troque os segredos expostos.',
    );
  else ok('Nenhum arquivo de segredo versionado');
} catch {
  warn('Nao foi possivel consultar o git', 'Rode dentro do repositorio.');
}
if (existsSync('.dev.vars')) ok('.dev.vars presente (desenvolvimento local)');
else warn('.dev.vars ausente', 'cp .dev.vars.example .dev.vars para rodar pnpm dev.');
const env = readEnvFile('.env');
const required = [
  'OTTO_BASE_URL',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'ADMIN_API_TOKEN',
];
const missing = required.filter((key) => !env[key]);
if (!existsSync('.env'))
  warn('.env ausente', 'Necessario so para scripts de producao: copie .env.example para .env.');
else if (missing.length)
  warn(
    `.env sem: ${missing.join(', ')}`,
    'Preencha com os mesmos valores cadastrados via wrangler secret put.',
  );
else ok('.env com as variaveis dos scripts (valores nao exibidos)');
if (env.TELEGRAM_WEBHOOK_SECRET) {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) {
    fail(
      'TELEGRAM_WEBHOOK_SECRET fraco ou com caracteres invalidos',
      'Use 32+ caracteres A-Z a-z 0-9 _ - (comando em docs/first-deployment.md).',
    );
  } else ok('TELEGRAM_WEBHOOK_SECRET com formato e tamanho adequados');
}
if (env.ADMIN_API_TOKEN) {
  if (env.ADMIN_API_TOKEN.length < 32 || env.ADMIN_API_TOKEN === 'local-admin-token') {
    fail('ADMIN_API_TOKEN curto ou igual ao exemplo', 'Gere um valor aleatorio de 32+ caracteres.');
  } else if (env.ADMIN_API_TOKEN === env.TELEGRAM_WEBHOOK_SECRET) {
    fail('ADMIN_API_TOKEN igual ao segredo do webhook', 'Use valores diferentes.');
  } else ok('ADMIN_API_TOKEN com tamanho adequado');
}

section('Banco local');
try {
  const out = wrangler(['d1', 'migrations', 'list', 'DB', '--local']);
  if (/No migrations to apply/i.test(out)) ok('Migracoes locais aplicadas');
  else warn('Ha migracoes locais pendentes', 'Rode pnpm db:migrate:local.');
} catch {
  warn('Nao foi possivel listar migracoes locais', 'Rode pnpm db:migrate:local.');
}

if (remote) {
  section('Cloudflare (producao)');
  try {
    const who = wrangler(['whoami']);
    if (/not authenticated/i.test(who)) throw new Error('nao autenticado');
    ok('Wrangler autenticado');
    try {
      const out = wrangler(['d1', 'migrations', 'list', 'DB', '--remote', '--env', 'production']);
      if (/No migrations to apply/i.test(out)) ok('Migracoes de producao aplicadas');
      else
        fail(
          'Migracoes de producao pendentes',
          'Faca backup (pnpm backup:prod) e rode pnpm db:migrate:prod.',
        );
    } catch {
      fail('Nao foi possivel consultar o banco de producao', 'Confira o database_id e o login.');
    }
    try {
      const out = wrangler(['secret', 'list', '--env', 'production']);
      const names = JSON.parse(out.slice(out.indexOf('['))).map((s) => s.name);
      const needed = [
        'TELEGRAM_BOT_TOKEN',
        'TELEGRAM_WEBHOOK_SECRET',
        'ADMIN_API_TOKEN',
        'OPENAI_API_KEY',
      ];
      const absent = needed.filter((n) => !names.includes(n));
      if (absent.length)
        fail(
          `Segredos ausentes no Worker: ${absent.join(', ')}`,
          'wrangler secret put NOME --env production',
        );
      else ok('Segredos cadastrados no Worker (nomes conferidos, valores nao lidos)');
    } catch {
      warn(
        'Nao foi possivel listar os segredos',
        'O Worker ja foi publicado? Rode pnpm run deploy primeiro.',
      );
    }
  } catch {
    fail('Wrangler sem login', 'Rode pnpm exec wrangler login.');
  }
  if (env.OTTO_BASE_URL) {
    try {
      const response = await fetch(`${env.OTTO_BASE_URL.replace(/\/$/, '')}/health`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) ok('Worker no ar (/health)');
      else
        fail(
          `/health respondeu ${response.status}`,
          'Veja os logs: pnpm exec wrangler tail --env production.',
        );
    } catch (error) {
      fail(
        `/health inacessivel (${describeNetworkError(error)})`,
        'Confira OTTO_BASE_URL e se o deploy foi feito.',
      );
    }
  }
} else {
  console.log('\n(Use pnpm doctor -- --remote para checar a Cloudflare.)');
}

console.log(`\n${failures} erro(s), ${warnings} aviso(s).`);
process.exitCode = failures > 0 ? 1 : 0;
