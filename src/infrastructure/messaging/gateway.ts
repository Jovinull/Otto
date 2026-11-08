/** Contrato de envio. O dominio e a aplicacao nao conhecem o Telegram. */
export interface InlineButton {
  text: string;
  data: string;
}

export interface OutgoingMessage {
  chatId: string;
  text: string;
  replyToMessageId: number | null;
  buttons: InlineButton[][] | null;
}

export interface MessagingGateway {
  /** Lanca RetryableError em falhas temporarias e PermanentError nas definitivas. */
  sendMessage(message: OutgoingMessage): Promise<void>;
  acknowledgeButton(callbackId: string, text?: string): Promise<void>;
}

/** Evento recebido, ja independente do provedor de mensageria. */
export interface InboundEvent {
  updateId: number;
  kind: 'message' | 'edited_message' | 'callback_query';
  chatId: string;
  chatType: string;
  senderId: string;
  senderIsBot: boolean;
  messageId: number;
  date: number;
  text: string | null;
  replyToText: string | null;
  replyToBot: boolean;
  callbackId: string | null;
  callbackData: string | null;
  migrateToChatId: string | null;
}
