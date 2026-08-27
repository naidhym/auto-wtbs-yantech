import type { ReactionResult, ReactionResultStatus } from '../reaction/reaction-result.js';
import type { ReplyResult } from '../reply/reply-result.js';

export interface ActionReportContext {
  readonly senderDisplayName: string;
  readonly delayMs: number;
  readonly sourceMessageLink?: string;
}

export interface ActionReport {
  readonly accountId: number;
  readonly accountKey: string;
  readonly accountNickname: string;
  readonly channelId: number;
  readonly channelTitle: string;
  readonly senderDisplayName: string;
  readonly matchedTriggers: readonly string[];
  readonly sourceMessageId: number;
  readonly sourceMessageLink?: string;
  readonly replyStatus: 'sent' | 'failed';
  readonly replyMessageId?: number;
  readonly replyErrorCode?: string;
  readonly replyErrorMessage?: string;
  readonly reactionStatus: ReactionResultStatus;
  readonly reactionType?: string;
  readonly reactionTargetMessageId?: number;
  readonly reactionErrorCode?: string;
  readonly reactionErrorMessage?: string;
  readonly delayMs: number;
  readonly replyExecutedAt: string;
  readonly reactionExecutedAt: string;
  readonly generatedAt: string;
}

export interface ActionReportDelivery {
  readonly delivered: boolean;
  readonly destination: 'saved_messages';
  readonly accountId: number;
  readonly accountKey?: string;
  readonly report?: ActionReport;
  readonly errorCode?: 'ACCOUNT_NOT_FOUND' | 'CHANNEL_NOT_FOUND' | 'REPORT_DELIVERY_FAILED';
  readonly errorMessage?: string;
  readonly deliveredAt: string;
}

export interface SavedMessagesPayload {
  readonly text: string;
  readonly sourceMessageLink?: string;
}

export interface SavedMessagesGateway {
  sendToSavedMessages(
    accountKey: string,
    payload: SavedMessagesPayload,
  ): Promise<void>;
}

export interface ActionReportInput {
  readonly reply: ReplyResult;
  readonly reaction: ReactionResult;
  readonly context: ActionReportContext;
}
