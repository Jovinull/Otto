import { PermanentError, RetryableError } from '../../../shared/errors';
import { truncate } from '../../../shared/text';
import type { MessagingGateway, OutgoingMessage } from '../gateway';

const TIMEOUT_MS = 8_000;
const TELEGRAM_TEXT_LIMIT = 4096;

interface TelegramResponse {
  ok: boolean;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export class TelegramClient implements MessagingGateway {
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
  ) {}

  async sendMessage(message: OutgoingMessage): Promise<void> {
    await this.call('sendMessage', {
      chat_id: message.chatId,
      // Texto puro, sem parse_mode: conteudo do usuario nao vira formatacao.
      text: truncate(message.text, TELEGRAM_TEXT_LIMIT),
      ...(message.replyToMessageId !== null && {
        reply_parameters: {
          message_id: message.replyToMessageId,
          allow_sending_without_reply: true,
        },
      }),
      ...(message.buttons && {
        reply_markup: {
          inline_keyboard: message.buttons.map((row) =>
            row.map((button) => ({ text: button.text, callback_data: button.data })),
          ),
        },
      }),
    });
  }

  async acknowledgeButton(callbackId: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', {
      callback_query_id: callbackId,
      ...(text !== undefined && { text }),
    });
  }

  private async call(method: string, body: Record<string, unknown>): Promise<void> {
    let response: Response;
    try {
      response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      // A excecao pode carregar a URL com o token; ela nao e propagada.
      throw new RetryableError('telegram_network');
    }
    if (response.ok) {
      await response.body?.cancel();
      return;
    }
    const payload = await response
      .json<TelegramResponse>()
      .catch((): TelegramResponse => ({ ok: false }));
    if (response.status === 429) {
      throw new RetryableError(
        'telegram_rate_limited',
        (payload.parameters?.retry_after ?? 5) * 1000,
      );
    }
    if (response.status >= 500) throw new RetryableError(`telegram_${response.status}`);
    throw new PermanentError(`telegram_${response.status}`);
  }
}
