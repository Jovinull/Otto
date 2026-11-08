// Envia um update falso ao `wrangler dev`, como o Telegram faria.
// Uso: pnpm simulate -- --from 1001 "gastei 27 no uber"
//      pnpm simulate -- --edit 55 --from 1001 "/gasto 30 uber"
//      pnpm simulate -- --button "pa:c:<id>"
import { loadSettings, required } from './lib.mjs';

const settings = loadSettings(true);
required(settings, ['TELEGRAM_WEBHOOK_SECRET']);

const args = process.argv.slice(2).filter((arg) => arg !== '--' && arg !== '--local');
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const [, value] = args.splice(index, 2);
  return value;
};
const from = Number(option('--from', settings.OTTO_MEMBER_1_TELEGRAM_ID || '1001'));
const chat = Number(option('--chat', settings.OTTO_TELEGRAM_CHAT_ID || '-1001'));
const editId = option('--edit', null);
const button = option('--button', null);
const text = args.join(' ');
const updateId = Date.now() % 2_000_000_000;
const date = Math.floor(Date.now() / 1000);

const update = button
  ? {
      update_id: updateId,
      callback_query: {
        id: `sim-${updateId}`,
        from: { id: from, is_bot: false },
        data: button,
        message: { message_id: updateId, date, chat: { id: chat, type: 'supergroup' } },
      },
    }
  : {
      update_id: updateId,
      [editId ? 'edited_message' : 'message']: {
        message_id: editId ? Number(editId) : updateId,
        date,
        chat: { id: chat, type: 'supergroup' },
        from: { id: from, is_bot: false },
        text,
      },
    };

const response = await fetch(`${settings.OTTO_BASE_URL}/webhook/telegram`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-telegram-bot-api-secret-token': settings.TELEGRAM_WEBHOOK_SECRET,
  },
  body: JSON.stringify(update),
});
console.log(`HTTP ${response.status}`);
console.log('As respostas aparecem no log do `pnpm dev` (envio ao Telegram falha sem token real).');
