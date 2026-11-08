/** Falha temporaria: o evento volta para a fila com backoff. */
export class RetryableError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterMs?: number,
  ) {
    super(code);
    this.name = 'RetryableError';
  }
}

/** Falha definitiva: nao adianta tentar de novo. */
export class PermanentError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PermanentError';
  }
}

/** Erro de regra de negocio cuja mensagem e segura para mostrar ao usuario. */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserFacingError';
  }
}

/** Codigo curto e sem dados do usuario para logs e banco. */
export function errorCode(error: unknown): string {
  if (error instanceof RetryableError || error instanceof PermanentError) return error.code;
  if (error instanceof Error) return error.name.slice(0, 40);
  return 'unknown_error';
}

/** Log estruturado. Nunca incluir texto de mensagem, valores ou segredos em `fields`. */
export function logEvent(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, string | number | boolean | null> = {},
): void {
  console[level](JSON.stringify({ level, event, ...fields }));
}
