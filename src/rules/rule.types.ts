export interface ReplyTemplateRecord {
  readonly id: number;
  readonly accountId: number;
  readonly accountKey: string;
  readonly accountNickname: string;
  readonly name: string;
  readonly body: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RuleRecord {
  readonly id: number;
  readonly ownerId: number;
  readonly channelId: number;
  readonly channelTitle: string;
  readonly replyTemplateId?: number;
  readonly replyTemplateName?: string;
  readonly replyTemplateAccountId?: number;
  readonly replyTemplateAccountKey?: string;
  readonly replyTemplateAccountNickname?: string;
  readonly name: string;
  readonly triggerKeywords: readonly string[];
  readonly excludeKeywords: readonly string[];
  readonly cleanupSenderPatterns: readonly string[];
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RuleInput {
  readonly name: string;
  readonly channelId: number;
  readonly triggerKeywords: readonly string[];
  readonly excludeKeywords: readonly string[];
  readonly cleanupSenderPatterns: readonly string[];
  readonly replyTemplateId?: number;
}

export type TelegramChatKind =
  | 'channel_post'
  | 'group'
  | 'supergroup'
  | 'discussion'
  | 'private'
  | 'unknown';

export interface TelegramSenderDisplayName {
  readonly source: 'post_author' | 'from_id_sender' | 'channel_title_fallback';
  readonly value: string;
}

export interface TelegramIncomingMessage {
  readonly chatKind: TelegramChatKind;
  readonly sourceMessageId?: number;
  readonly text: string;
  readonly senderDisplayName?: string;
  /** All non-empty sender names resolved from the native Telegram event. */
  readonly senderDisplayNames?: readonly TelegramSenderDisplayName[];
  readonly telegramChannelId?: string;
  /** Internal runtime trace only; never persisted as message content. */
  readonly nativeClientInstanceId?: string;
  /** Short runtime-only link across diagnostic lifecycle logs. */
  readonly correlationId?: string;
}

export type DetectionEventType =
  | 'MATCH'
  | 'EXCLUDED'
  | 'CLEANUP_MATCH';

export interface DetectionEvent {
  readonly type: DetectionEventType;
  readonly ruleId: number;
  readonly channelId: number;
  readonly accountKey: string;
  readonly reason: string;
  readonly matchedValue: string;
}
