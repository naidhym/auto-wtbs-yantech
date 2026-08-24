import type { TelegramIncomingMessage } from '../rules/rule.types.js';

export type ChannelOperationalStatus =
  | 'active'
  | 'disabled'
  | 'error'
  | 'inaccessible';

export interface ChannelRecord {
  readonly id: number;
  readonly telegramChannelId: string;
  readonly username?: string;
  readonly title: string;
  readonly enabled: boolean;
  readonly status: ChannelOperationalStatus;
  readonly automationBlocked?: boolean;
  readonly blockedReason?: string;
  readonly blockedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChannelAssignmentRecord {
  readonly id: number;
  readonly accountId: number;
  readonly accountKey: string;
  readonly accountNickname: string;
  readonly channelId: number;
  readonly enabled: boolean;
  readonly status: ChannelOperationalStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ResolvedTelegramChannel {
  readonly telegramChannelId: string;
  readonly username?: string;
  readonly title: string;
  readonly left?: boolean;
  readonly broadcast?: boolean;
  readonly megagroup?: boolean;
  readonly restricted?: boolean;
  readonly creator?: boolean;
  readonly entityType?: string;
  readonly adminRights?: readonly string[];
  readonly defaultBannedRights?: readonly string[];
}

export interface TelegramChannelSubscriptionContext {
  readonly assignmentId: number;
  readonly accountId: number;
  readonly accountSessionKey: string;
  readonly channelId: number;
  readonly expectedTelegramChannelId: string;
  readonly usernameUsedForResolution?: string;
}

export interface ChannelAccessGateway {
  resolve(accountKey: string, identifier: string): Promise<ResolvedTelegramChannel>;
  /** Stable only for the lifetime of the running process; used for listener diagnostics. */
  getNativeClientInstanceId?(accountKey: string): string | undefined;
  subscribe(
    accountKey: string,
    assignment: ChannelAssignmentRecord,
    channel: ChannelRecord,
    onMessage: (event: TelegramIncomingMessage) => Promise<void>,
    onError: (error: unknown) => Promise<void> | void,
  ): Promise<() => Promise<void>>;
}

export interface ChannelMessageProcessor {
  process(input: {
    readonly assignment: ChannelAssignmentRecord;
    readonly channel: ChannelRecord;
    readonly message: TelegramIncomingMessage;
  }): Promise<void> | void;
}
