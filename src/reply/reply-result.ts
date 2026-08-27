/**
 * Reply Execution Result
 *
 * Output of reply executor after attempting to send a reply to a Telegram channel post.
 *
 * SUCCESS:
 * - success = true
 * - replyMessageId populated with exact Telegram message ID
 *
 * FAILURE:
 * - success = false
 * - replyMessageId absent
 * - errorCode and errorMessage preserve actual failure reason
 */

export interface ReplyResult {
  readonly success: boolean;
  readonly accountId: number;
  readonly channelId: number;
  readonly sourceMessageId: number;
  readonly matchedTriggers: readonly string[];
  readonly replyMessageId?: number;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly executedAt: string;
}

export type ReplyErrorCode =
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_DISABLED'
  | 'ACCOUNT_DISCONNECTED'
  | 'ACCOUNT_CONFIGURATION_MISMATCH'
  | 'ACTIVE_TEMPLATE_NOT_FOUND'
  | 'INVALID_REPLY_DELAY'
  | 'CHANNEL_NOT_FOUND'
  | 'INVALID_SOURCE_MESSAGE_ID'
  | 'SOURCE_MESSAGE_UNAVAILABLE'
  | 'COMMENT_UNAVAILABLE'
  | 'TELEGRAM_PERMISSION_DENIED'
  | 'FLOOD_WAIT'
  | 'CONNECTION_FAILED'
  | 'TIMEOUT'
  | 'INVALID_ENTITY'
  | 'REPLY_MESSAGE_ID_MISSING'
  | 'EXECUTION_ABORTED'
  | 'TELEGRAM_ERROR'
  | 'REPLY_EXECUTION_FAILED';
