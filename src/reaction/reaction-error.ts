import { classifyReplyError } from '../reply/reply-error.js';
import type { ReactionErrorCode } from './reaction-result.js';

export class ReactionExecutionError extends Error {
  public override readonly name = 'ReactionExecutionError';

  public constructor(
    public readonly errorCode: ReactionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface ClassifiedReactionError {
  readonly errorCode: ReactionErrorCode;
  readonly errorMessage: string;
}

export function classifyReactionError(error: unknown): ClassifiedReactionError {
  if (error instanceof ReactionExecutionError) {
    return { errorCode: error.errorCode, errorMessage: error.message };
  }
  const classified = classifyReplyError(error);
  const searchable = classified.errorMessage.toUpperCase();
  if (/REACTION.*(INVALID|EMPTY)|VALID EMOJI/.test(searchable)) {
    return { errorCode: 'INVALID_REACTION', errorMessage: classified.errorMessage };
  }
  if (/EXACT TELEGRAM PEER|REACTION CONTEXT/.test(searchable)) {
    return {
      errorCode: 'REACTION_CONTEXT_UNAVAILABLE',
      errorMessage: classified.errorMessage,
    };
  }
  const mapped: Partial<Record<typeof classified.errorCode, ReactionErrorCode>> = {
    ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
    ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
    ACCOUNT_DISCONNECTED: 'ACCOUNT_DISCONNECTED',
    ACCOUNT_CONFIGURATION_MISMATCH: 'ACCOUNT_CONFIGURATION_MISMATCH',
    CHANNEL_NOT_FOUND: 'CHANNEL_NOT_FOUND',
    SOURCE_MESSAGE_UNAVAILABLE: 'MESSAGE_UNAVAILABLE',
    TELEGRAM_PERMISSION_DENIED: 'TELEGRAM_PERMISSION_DENIED',
    FLOOD_WAIT: 'FLOOD_WAIT',
    CONNECTION_FAILED: 'CONNECTION_FAILED',
    TIMEOUT: 'TIMEOUT',
    INVALID_ENTITY: 'INVALID_ENTITY',
    TELEGRAM_ERROR: 'TELEGRAM_ERROR',
  };
  return {
    errorCode: mapped[classified.errorCode] ?? 'REACTION_EXECUTION_FAILED',
    errorMessage: classified.errorMessage,
  };
}
