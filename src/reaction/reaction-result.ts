export type ReactionResultStatus = 'not_applicable' | 'disabled' | 'sent' | 'failed';

export type ReactionErrorCode =
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_DISABLED'
  | 'ACCOUNT_DISCONNECTED'
  | 'ACCOUNT_CONFIGURATION_MISMATCH'
  | 'CHANNEL_NOT_FOUND'
  | 'REPLY_MESSAGE_ID_MISSING'
  | 'REACTION_CONTEXT_UNAVAILABLE'
  | 'REACTION_UNAVAILABLE'
  | 'INVALID_REACTION'
  | 'MESSAGE_UNAVAILABLE'
  | 'TELEGRAM_PERMISSION_DENIED'
  | 'FLOOD_WAIT'
  | 'CONNECTION_FAILED'
  | 'TIMEOUT'
  | 'INVALID_ENTITY'
  | 'TELEGRAM_ERROR'
  | 'REACTION_EXECUTION_FAILED';

export interface ReactionResult {
  readonly status: ReactionResultStatus;
  readonly attempted: boolean;
  readonly success: boolean;
  readonly reactionType?: string;
  readonly targetMessageId?: number;
  readonly skippedReason?: 'reply_failed' | 'reaction_disabled';
  readonly errorCode?: ReactionErrorCode;
  readonly errorMessage?: string;
  readonly executedAt: string;
}

export interface ReplyReactionTarget {
  readonly channelIdentifier: string;
  readonly replyMessageId: number;
  readonly reactionType: string;
}

export interface ReplyReactionAttempt {
  readonly status: 'sent' | 'unavailable';
  readonly reason?: string;
}

export interface ReplyReactionGateway {
  reactToReply(
    accountKey: string,
    target: ReplyReactionTarget,
  ): Promise<ReplyReactionAttempt>;
}
