/**
 * Normalized Telegram Events
 *
 * These events are emitted by the Telegram update engine after normalizing
 * raw GramJS protocol data. Business logic consumes these events instead of
 * raw Telegram API objects, enabling testability and separation of concerns.
 */

export interface ChannelPostReceived {
  type: 'channel_post_received';
  accountId: number;
  accountKey: string;
  channelId: number;
  telegramChannelId: string;
  messageId: number;
  text: string;
  senderDisplayName: string;
  timestamp: Date;
  isHistorical: boolean;
  correlationId: string;
}

export interface ChannelSyncStateChanged {
  type: 'channel_sync_state_changed';
  accountId: number;
  accountKey: string;
  channelId: number;
  telegramChannelId: string;
  oldStatus: 'pending' | 'connecting' | 'syncing' | 'healthy' | 'degraded' | 'error' | 'disconnected';
  newStatus: 'pending' | 'connecting' | 'syncing' | 'healthy' | 'degraded' | 'error' | 'disconnected';
  reason?: string;
  timestamp: Date;
}

export interface ChannelSubscriptionAdded {
  type: 'channel_subscription_added';
  accountId: number;
  accountKey: string;
  channelId: number;
  telegramChannelId: string;
  timestamp: Date;
}

export interface ChannelSubscriptionRemoved {
  type: 'channel_subscription_removed';
  accountId: number;
  accountKey: string;
  channelId: number;
  telegramChannelId: string;
  timestamp: Date;
}

export interface AccountConnectionStateChanged {
  type: 'account_connection_state_changed';
  accountId: number;
  accountKey: string;
  oldState: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';
  newState: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';
  reason?: string;
  timestamp: Date;
}

export type TelegramEvent =
  | ChannelPostReceived
  | ChannelSyncStateChanged
  | ChannelSubscriptionAdded
  | ChannelSubscriptionRemoved
  | AccountConnectionStateChanged;

export interface EventSubscriber {
  onEvent(event: TelegramEvent): Promise<void>;
}

export class TelegramEventBus {
  private subscribers: Set<EventSubscriber> = new Set();

  subscribe(subscriber: EventSubscriber): void {
    this.subscribers.add(subscriber);
  }

  unsubscribe(subscriber: EventSubscriber): void {
    this.subscribers.delete(subscriber);
  }

  async emit(event: TelegramEvent): Promise<void> {
    const promises = Array.from(this.subscribers).map((subscriber) =>
      Promise.resolve()
        .then(() => subscriber.onEvent(event))
        .catch((error) => {
          // Log but don't throw; other subscribers should still run
          console.error(
            `Error in event subscriber for ${event.type}:`,
            error,
          );
        }),
    );

    await Promise.all(promises);
  }
}
