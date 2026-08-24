export interface AccountAutomationSettings {
  readonly accountId: number;
  readonly accountKey: string;
  readonly accountNickname: string;
  readonly replyDelayMs: number;
  readonly autoReaction: boolean;
  readonly cooldownMs: number;
  readonly hourlyLimit: number;
  readonly dailyLimit: number;
  /** Telegram bot username or numeric peer to receive this account's operational notices. */
  readonly notificationTarget?: string;
  readonly updatedAt: string;
}

export type ReactionStatus = 'sent' | 'skipped' | 'failed';

export interface SentReply {
  readonly messageId: number;
  resolveMessageLink(): Promise<string>;
  reactToOwnComment(): Promise<ReactionAttemptResult>;
}

export interface ReactionAttemptResult {
  readonly status: 'sent' | 'skipped';
  readonly reason?: string;
}

export interface AutoReplyGateway {
  isAvailable(accountKey: string): boolean;
  sendComment(
    accountKey: string,
    channelIdentifier: string,
    sourceMessageId: number,
    text: string,
  ): Promise<SentReply>;
}

export type OwnerNotification = {
  readonly type: 'cleanup_blocked';
      readonly channelTitle: string;
      readonly pattern: string;
};

export interface OwnerNotificationGateway {
  notify(notification: OwnerNotification): Promise<boolean>;
}

export type AccountNotification =
  | {
      readonly type: 'reply_sent';
      readonly accountNickname?: string;
      readonly channelTitle: string;
      readonly trigger: string;
      readonly sourceMessageLink: string;
    }
  | {
      readonly type: 'reply_failed';
      readonly accountNickname?: string;
      readonly channelTitle: string;
      readonly reason: string;
    }

export interface AccountNotificationGateway {
  notify(accountKey: string, notification: AccountNotification): Promise<boolean>;
}

export interface DelayScheduler {
  wait(milliseconds: number, signal?: AbortSignal): Promise<void>;
}
