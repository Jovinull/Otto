import type { Deps } from './application/context';
import { runHourly, runRecovery } from './application/jobs/scheduled';
import type { Bindings } from './config/env';
import { loadConfig } from './config/env';
import { OpenAiClient } from './infrastructure/ai/client';
import { createDb } from './infrastructure/database/client';
import type { Meter } from './infrastructure/database/metered';
import { meteredFetch, meterD1 } from './infrastructure/database/metered';
import { TelegramClient } from './infrastructure/messaging/telegram/client';
import { createApp } from './interfaces/http/routes';

export function createDeps(env: Bindings): Deps {
  const config = loadConfig(env);
  const meter: Meter = { count: 0 };
  const fetcher = meteredFetch(meter);
  return {
    db: createDb(meterD1(env.DB, meter)),
    messaging: config.telegramBotToken
      ? new TelegramClient(config.telegramBotToken, fetcher)
      : null,
    ai: config.openAiApiKey ? new OpenAiClient(config, config.openAiApiKey, fetcher) : null,
    meter,
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
