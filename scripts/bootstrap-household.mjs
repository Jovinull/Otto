// Cadastra o Household e os membros autorizados. So funciona uma vez por banco.
// Uso: pnpm bootstrap:household            (producao, le .env)
//      pnpm bootstrap:household -- --local (wrangler dev, le .dev.vars + .env)
import { loadSettings, required } from './lib.mjs';

const settings = loadSettings();
required(settings, [
  'OTTO_BASE_URL',
  'ADMIN_API_TOKEN',
  'OTTO_HOUSEHOLD_NAME',
  'OTTO_TELEGRAM_CHAT_ID',
  'OTTO_MEMBER_1_NAME',
  'OTTO_MEMBER_1_TELEGRAM_ID',
]);

const members = [1, 2]
  .filter((n) => settings[`OTTO_MEMBER_${n}_NAME`] && settings[`OTTO_MEMBER_${n}_TELEGRAM_ID`])
  .map((n) => ({
    name: settings[`OTTO_MEMBER_${n}_NAME`],
    telegramUserId: settings[`OTTO_MEMBER_${n}_TELEGRAM_ID`],
    role: 'admin',
  }));

const response = await fetch(`${settings.OTTO_BASE_URL}/admin/bootstrap`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${settings.ADMIN_API_TOKEN}`,
  },
  body: JSON.stringify({
    householdName: settings.OTTO_HOUSEHOLD_NAME,
    timezone: settings.OTTO_TIMEZONE || 'America/Maceio',
    telegramChatId: settings.OTTO_TELEGRAM_CHAT_ID,
    members,
  }),
});
console.log(`HTTP ${response.status}`, await response.text());
if (!response.ok) process.exit(1);
