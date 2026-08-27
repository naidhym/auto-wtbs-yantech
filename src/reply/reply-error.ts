import type { ReplyErrorCode } from './reply-result.js';

export class ReplyExecutionError extends Error {
  public override readonly name = 'ReplyExecutionError';

  public constructor(
    public readonly errorCode: ReplyErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface ClassifiedReplyError {
  readonly errorCode: ReplyErrorCode;
  readonly errorMessage: string;
}

export function classifyReplyError(error: unknown): ClassifiedReplyError {
  if (error instanceof ReplyExecutionError) {
    return {
      errorCode: error.errorCode,
      errorMessage: error.message,
    };
  }

  const errorMessage = extractErrorMessage(error);
  const searchable = [
    errorMessage,
    readString(error, 'errorMessage'),
    readString(error, 'name'),
    readString(error, 'code'),
  ].filter((value): value is string => value !== undefined).join(' ').toUpperCase();

  if (/FLOOD[_ ]?WAIT|FLOODWAIT/.test(searchable)) {
    return { errorCode: 'FLOOD_WAIT', errorMessage };
  }
  if (/TIMEOUT|TIMED OUT|ETIMEDOUT/.test(searchable)) {
    return { errorCode: 'TIMEOUT', errorMessage };
  }
  if (/MSG_ID_INVALID|MESSAGE_ID_INVALID|MESSAGE TO REPLY NOT FOUND|REPLY_MESSAGE_ID_INVALID/.test(searchable)) {
    return { errorCode: 'SOURCE_MESSAGE_UNAVAILABLE', errorMessage };
  }
  if (/COMMENTS_DISABLED|COMMENT.*DISABLED|CHAT_GUEST_SEND_FORBIDDEN|REPLIES.*DISABLED/.test(searchable)) {
    return { errorCode: 'COMMENT_UNAVAILABLE', errorMessage };
  }
  if (/CHAT_WRITE_FORBIDDEN|CHANNEL_PRIVATE|USER_BANNED_IN_CHANNEL|CHAT_ADMIN_REQUIRED|WRITE_FORBIDDEN/.test(searchable)) {
    return { errorCode: 'TELEGRAM_PERMISSION_DENIED', errorMessage };
  }
  if (/ENTITY|PEER_ID_INVALID|CHANNEL_INVALID|USERNAME_INVALID|USERNAME_NOT_OCCUPIED/.test(searchable)) {
    return { errorCode: 'INVALID_ENTITY', errorMessage };
  }
  if (/NOT CONNECTED|DISCONNECTED|AUTH_KEY_UNREGISTERED|SESSION_REVOKED/.test(searchable)) {
    return { errorCode: 'ACCOUNT_DISCONNECTED', errorMessage };
  }
  if (/CONNECTION|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|SOCKET/.test(searchable)) {
    return { errorCode: 'CONNECTION_FAILED', errorMessage };
  }
  if (isTelegramError(error, searchable)) {
    return { errorCode: 'TELEGRAM_ERROR', errorMessage };
  }
  return { errorCode: 'REPLY_EXECUTION_FAILED', errorMessage };
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  const telegramMessage = readString(error, 'errorMessage');
  if (telegramMessage !== undefined && telegramMessage.trim().length > 0) return telegramMessage;
  if (typeof error === 'string' && error.trim().length > 0) return error;
  return 'Unknown reply execution failure';
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || !(key in value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  if (typeof field === 'string') return field;
  if (typeof field === 'number') return String(field);
  return undefined;
}

function isTelegramError(error: unknown, searchable: string): boolean {
  if (/RPCERROR|RPC_ERROR|TELEGRAM/.test(searchable)) return true;
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as Record<string, unknown>).code;
  return typeof code === 'number';
}
