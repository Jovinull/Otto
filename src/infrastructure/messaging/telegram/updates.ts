import * as z from 'zod';
import type { InboundEvent } from '../gateway';

const User = z.object({ id: z.number().int(), is_bot: z.boolean().optional() });
const Chat = z.object({ id: z.number().int(), type: z.string() });

const Message = z.object({
  message_id: z.number().int(),
  date: z.number().int(),
  chat: Chat,
  from: User.optional(),
  text: z.string().optional(),
  migrate_to_chat_id: z.number().int().optional(),
  reply_to_message: z.object({ text: z.string().optional(), from: User.optional() }).optional(),
});

const CallbackQuery = z.object({
  id: z.string(),
  from: User,
  data: z.string().optional(),
  message: z
    .object({ message_id: z.number().int(), date: z.number().int(), chat: Chat })
    .optional(),
});

export const TelegramUpdate = z.object({
  update_id: z.number().int(),
  message: Message.optional(),
  edited_message: Message.optional(),
  callback_query: CallbackQuery.optional(),
});
export type TelegramUpdate = z.infer<typeof TelegramUpdate>;

/** Tamanho maximo de texto aceito: o proprio limite do Telegram para mensagens. */
export const MAX_TEXT_LENGTH = 4096;

function fromMessage(
  updateId: number,
  kind: 'message' | 'edited_message',
  message: z.infer<typeof Message>,
): InboundEvent | null {
  if (!message.from) return null;
  if (message.text !== undefined && message.text.length > MAX_TEXT_LENGTH) return null;
  return {
    updateId,
    kind,
    chatId: String(message.chat.id),
    chatType: message.chat.type,
    senderId: String(message.from.id),
    senderIsBot: message.from.is_bot ?? false,
    messageId: message.message_id,
    date: message.date,
    text: message.text ?? null,
    replyToText: message.reply_to_message?.text ?? null,
    replyToBot: message.reply_to_message?.from?.is_bot ?? false,
    callbackId: null,
    callbackData: null,
    migrateToChatId:
      message.migrate_to_chat_id === undefined ? null : String(message.migrate_to_chat_id),
  };
}

/** Converte o update em evento neutro. Retorna null para tipos que o Otto nao trata. */
export function toInboundEvent(update: TelegramUpdate): InboundEvent | null {
  if (update.message) return fromMessage(update.update_id, 'message', update.message);
  if (update.edited_message) {
    return fromMessage(update.update_id, 'edited_message', update.edited_message);
  }
  const callback = update.callback_query;
  if (callback?.message && callback.data && callback.data.length <= 64) {
    return {
      updateId: update.update_id,
      kind: 'callback_query',
      chatId: String(callback.message.chat.id),
      chatType: callback.message.chat.type,
      senderId: String(callback.from.id),
      senderIsBot: callback.from.is_bot ?? false,
      messageId: callback.message.message_id,
      date: callback.message.date,
      text: null,
      replyToText: null,
      replyToBot: false,
      callbackId: callback.id,
      callbackData: callback.data,
      migrateToChatId: null,
    };
  }
  return null;
}
