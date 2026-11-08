import type { Deps } from './application/context';
import { runHourly, runRecovery } from './application/jobs/scheduled';
import type { Bindings } from './config/env';
import { loadConfig } from './config/env';
import { OpenAiClient } from './infrastructure/ai/client';
import { createDb } from './infrastructure/database/client';
import { TelegramClient } from './infrastructure/messaging/telegram/client';
import { createApp } from './interfaces/http/routes';

export function createDeps(env: Bindings): Deps {
  const config = loadConfig(env);
  return {
    db: createDb(env.DB),
    messaging: config.telegramBotToken ? new TelegramClient(config.telegramBotToken) : null,
    ai: config.openAiApiKey ? new OpenAiClient(config, config.openAiApiKey) : null,
    config,
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
  };
}

export const HOURLY_CRON = '0 * * * *';

export async function handleScheduled(
  deps: Deps,
  cron: string,
  scheduledTime: number,
): Promise<void> {
  if (cron === HOURLY_CRON) await runHourly(deps, scheduledTime);
  else await runRecovery(deps);
}

export const app = createApp(createDeps);
