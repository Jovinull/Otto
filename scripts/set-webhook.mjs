// Registra o webhook no Telegram com secret_token e mostra o estado, sem imprimir o token.
// Uso: pnpm telegram:webhook             registra
//      pnpm telegram:webhook -- --info   apenas consulta
//      pnpm telegram:webhook -- --remove pausa o bot: o Telegram guarda os updates por ate 24 h
import { loadSettings, required } from './lib.mjs';

const settings = loadSettings();
required(settings, ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'OTTO_BASE_URL']);
const api = (method) => `https://api.telegram.org/bot${settings.TELEGRAM_BOT_TOKEN}/${method}`;

if (!/^[A-Za-z0-9_-]{1,256}$/.test(settings.TELEGRAM_WEBHOOK_SECRET)) {
  console.error('TELEGRAM_WEBHOOK_SECRET aceita apenas A-Z, a-z, 0-9, _ e -, ate 256 caracteres.');
  process.exit(1);
}
if (!settings.OTTO_BASE_URL.startsWith('https://')) {
  console.error('OTTO_BASE_URL precisa ser HTTPS (ex.: https://otto.SEU-SUBDOMINIO.workers.dev).');
  process.exit(1);
}

if (process.argv.includes('--remove')) {
  const response = await fetch(api('deleteWebhook'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Sem drop_pending_updates: nada enviado no grupo se perde enquanto pausado (ate 24 h).
    body: JSON.stringify({ drop_pending_updates: false }),
  });
  const result = await response.json();
  console.log(
    'deleteWebhook:',
    result.ok ? 'ok (bot pausado; dados intactos)' : result.description,
  );
} else if (!process.argv.includes('--info')) {
  const response = await fetch(api('setWebhook'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: `${settings.OTTO_BASE_URL}/webhook/telegram`,
      secret_token: settings.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ['message', 'edited_message', 'callback_query'],
      // Uma conexao: o Telegram entrega um update por vez, o que preserva a ordem de chegada.
      max_connections: 1,
    }),
  });
  const result = await response.json();
  console.log('setWebhook:', result.ok ? 'ok' : result.description);
}

const info = await (await fetch(api('getWebhookInfo'))).json();
const { url, pending_update_count, last_error_message, last_error_date } = info.result ?? {};
console.log({ url, pending_update_count, last_error_message, last_error_date });
