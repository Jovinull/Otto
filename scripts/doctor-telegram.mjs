// Diagnostico somente leitura do Telegram. Nao altera webhook nem configuracoes.
// Uso: pnpm doctor:telegram
import { describeNetworkError, loadSettings } from './lib.mjs';

const settings = loadSettings();
let failures = 0;
let warnings = 0;
const ok = (label, detail = '') => console.log(`✅ ${label}${detail ? ` — ${detail}` : ''}`);
const warn = (label, fix) => {
  warnings += 1;
  console.log(`⚠️  ${label}\n   → ${fix}`);
};
const fail = (label, fix) => {
  failures += 1;
  console.log(`❌ ${label}\n   → ${fix}`);
};

async function call(method, params = {}) {
  const url = new URL(`https://api.telegram.org/bot${settings.TELEGRAM_BOT_TOKEN}/${method}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    return { ok: false, description: describeNetworkError(error) };
  }
  return response.json().catch(() => ({ ok: false, description: `HTTP ${response.status}` }));
}

if (!settings.TELEGRAM_BOT_TOKEN) {
  fail('TELEGRAM_BOT_TOKEN ausente no .env', 'Copie o token do BotFather para o .env local.');
  process.exitCode = 1;
} else {
  const me = await call('getMe');
  if (!me.ok) {
    fail(
      `Token recusado pelo Telegram (${me.description ?? 'erro'})`,
      'Confira o token no BotFather (/token) e no .env.',
    );
  } else {
    const bot = me.result;
    ok('Token valido', `bot @${bot.username} (id ${bot.id})`);
    if (bot.can_join_groups) {
      warn(
        'Bot pode ser adicionado a outros grupos',
        'No BotFather: /setjoingroups → Disable, depois de adicioná-lo ao grupo do casal.',
      );
    } else {
      ok('Bot nao pode ser adicionado a outros grupos');
    }

    const info = await call('getWebhookInfo');
    const webhook = info.result ?? {};
    const expectedUrl = settings.OTTO_BASE_URL
      ? `${settings.OTTO_BASE_URL.replace(/\/$/, '')}/webhook/telegram`
      : null;
    if (!webhook.url) {
      fail('Webhook nao configurado', 'Rode pnpm telegram:webhook depois do deploy.');
    } else if (expectedUrl && webhook.url !== expectedUrl) {
      fail(
        `Webhook aponta para outra URL (${webhook.url})`,
        `Esperado ${expectedUrl}. Rode pnpm telegram:webhook.`,
      );
    } else {
      ok('Webhook configurado', webhook.url);
    }
    const allowed = webhook.allowed_updates ?? [];
    const needed = ['message', 'edited_message', 'callback_query'];
    if (webhook.url && !needed.every((u) => allowed.includes(u))) {
      warn(
        `Tipos de update incompletos (${allowed.join(', ') || 'padrao'})`,
        'Rode pnpm telegram:webhook para registrar message, edited_message e callback_query.',
      );
    }
    if (webhook.url && webhook.max_connections !== 1) {
      warn(
        `max_connections = ${webhook.max_connections}`,
        'Use 1 para preservar a ordem das mensagens: pnpm telegram:webhook.',
      );
    }
    if (webhook.pending_update_count > 0) {
      warn(
        `${webhook.pending_update_count} update(s) aguardando entrega`,
        'Se nao baixar em minutos, o Worker esta recusando: veja last_error abaixo e wrangler tail.',
      );
    } else if (webhook.url) {
      ok('Nenhum update parado na fila do Telegram');
    }
    if (webhook.last_error_date) {
      const minutes = Math.round((Date.now() / 1000 - webhook.last_error_date) / 60);
      const message = `Ultimo erro de entrega ha ${minutes} min: ${webhook.last_error_message}`;
      if (minutes < 60)
        fail(
          message,
          'Confira se o deploy esta no ar (/health) e se TELEGRAM_WEBHOOK_SECRET e igual no Worker e no .env.',
        );
      else warn(message, 'Erro antigo; se nao se repetir, pode ignorar.');
    }

    const chatId = settings.OTTO_TELEGRAM_CHAT_ID;
    if (!chatId) {
      warn(
        'OTTO_TELEGRAM_CHAT_ID ausente no .env',
        'Descubra com /id no grupo para checar permissoes do bot.',
      );
    } else {
      const chat = await call('getChat', { chat_id: chatId });
      if (!chat.ok) {
        fail(
          `Grupo ${chatId} inacessivel (${chat.description})`,
          'Confira o ID e se o bot ainda esta no grupo.',
        );
      } else {
        ok('Grupo encontrado', `tipo ${chat.result.type}`);
        const member = await call('getChatMember', { chat_id: chatId, user_id: bot.id });
        const status = member.result?.status;
        const readsAll = bot.can_read_all_group_messages || status === 'administrator';
        if (readsAll)
          ok(
            'Bot le as mensagens comuns do grupo',
            status === 'administrator' ? 'bot e administrador' : 'Privacy Mode desligado',
          );
        else
          fail(
            'Bot so ve comandos (Privacy Mode ligado e sem ser admin)',
            'Torne o bot administrador do grupo, ou /setprivacy → Disable e readicione o bot.',
          );
        const count = await call('getChatMemberCount', { chat_id: chatId });
        if (count.ok && count.result > 3) {
          warn(
            `O grupo tem ${count.result} membros`,
            'Todos veem as respostas financeiras. O ideal e apenas o casal e o bot.',
          );
        } else if (count.ok) {
          ok('Grupo restrito', `${count.result} membros`);
        }
      }
    }
  }
  console.log(`\n${failures} erro(s), ${warnings} aviso(s). Nenhuma configuracao foi alterada.`);
  process.exitCode = failures > 0 ? 1 : 0;
}
