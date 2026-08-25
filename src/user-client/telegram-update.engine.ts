import { Api, TelegramClient, utils } from 'telegram';
import { Raw } from 'telegram/events/index.js';

import type { ChannelRecord } from '../channels/channel.types.js';
import { errorReason, type AppLogger } from '../logging/logger.js';
import type { TelegramIncomingMessage } from '../rules/rule.types.js';
import { mapGramJsEvent, resolveBroadcastChannel } from './gramjs-client.service.js';
import {
  TelegramChannelSyncStateRepository,
  type TelegramChannelSyncStateRecord,
  type TelegramChannelSyncStatus,
} from './telegram-channel-sync-state.repository.js';

export interface TelegramEngineSubscription {
  readonly assignmentId: number;
  readonly accountId: number;
  readonly accountKey: string;
  readonly channel: ChannelRecord;
  readonly identifier: string;
  readonly onLivePost: (event: TelegramIncomingMessage) => Promise<void>;
  readonly onError: (error: unknown) => Promise<void> | void;
}

export type TelegramEngineChannelHealth = 'CONNECTING' | 'SYNCING' | 'HEALTHY' | 'DEGRADED' | 'ERROR' | 'DISCONNECTED';

export interface TelegramEngineChannelStatus {
  readonly accountId: number;
  readonly channelId: number;
  readonly telegramChannelId: string;
  readonly title: string;
  readonly health: TelegramEngineChannelHealth;
  readonly pts: number;
  readonly lastSyncAt?: string;
  readonly lastError?: string;
}

export interface TelegramEngineStatus {
  readonly accountKey: string;
  readonly connected: boolean;
  readonly channels: readonly TelegramEngineChannelStatus[];
  readonly syncedChannels: number;
  readonly degradedChannels: number;
}

interface EngineChannelState {
  entity: Api.Channel;
  readonly channel: ChannelRecord;
  readonly accountId: number;
  readonly identifier: string;
  readonly listeners: Map<number, TelegramEngineSubscription>;
  sync: TelegramChannelSyncStateRecord;
  recovery?: Promise<void>;
}

export class TelegramUpdateEngine {
  private readonly channels = new Map<string, EngineChannelState>();
  private readonly liveBuilder = new Raw({ types: [Api.UpdateNewChannelMessage, Api.UpdateChannelTooLong] });
  private liveHandlerRegistered = false;

  public constructor(
    private readonly accountKey: string,
    private readonly client: TelegramClient,
    private readonly syncStates: TelegramChannelSyncStateRepository,
    private readonly logger: AppLogger,
  ) {}

  public async subscribe(input: TelegramEngineSubscription): Promise<() => Promise<void>> {
    const entity = await resolveBroadcastChannel(this.client, input.identifier);
    const channelKey = entity.id.toString();
    const existing = this.channels.get(channelKey);
    const sync = this.syncStates.ensure(input.accountId, input.channel.id);
    const state: EngineChannelState = existing ?? {
      entity,
      channel: input.channel,
      accountId: input.accountId,
      identifier: input.identifier,
      listeners: new Map<number, TelegramEngineSubscription>(),
      sync,
    };
    state.entity = entity;
    state.sync = this.syncStates.markConnecting(input.accountId, input.channel.id);
    state.listeners.set(input.assignmentId, input);
    this.channels.set(channelKey, state);
    this.ensureLiveHandler();
    await this.synchronize(state, 'startup');

    return () => {
      const current = this.channels.get(channelKey);
      if (current === undefined) return Promise.resolve();
      current.listeners.delete(input.assignmentId);
      if (current.listeners.size === 0) {
        current.sync = this.syncStates.markDisconnected(current.accountId, current.channel.id);
        this.channels.delete(channelKey);
      }
      return Promise.resolve();
    };
  }

  public async resynchronizeAll(reason: 'startup' | 'reconnect' = 'reconnect'): Promise<void> {
    await Promise.allSettled([...this.channels.values()].map(async (state) => this.synchronize(state, reason)));
  }

  public markAllDisconnected(reason = 'telegram_client_disconnected'): void {
    for (const state of this.channels.values()) {
      state.sync = this.syncStates.markDisconnected(state.accountId, state.channel.id, reason);
    }
  }

  public getStatus(): TelegramEngineStatus {
    const channels = [...this.channels.values()].map((state) => ({
      accountId: state.accountId,
      channelId: state.channel.id,
      telegramChannelId: state.entity.id.toString(),
      title: state.channel.title,
      health: mapHealth(state.sync.syncStatus),
      pts: state.sync.pts,
      ...(state.sync.lastSuccessfulSyncAt === undefined ? {} : { lastSyncAt: state.sync.lastSuccessfulSyncAt }),
      ...(state.sync.lastError === undefined ? {} : { lastError: state.sync.lastError }),
    }));
    return {
      accountKey: this.accountKey,
      connected: this.client.connected === true,
      channels,
      syncedChannels: channels.filter((channel) => channel.health === 'HEALTHY').length,
      degradedChannels: channels.filter((channel) => channel.health !== 'HEALTHY').length,
    };
  }

  private ensureLiveHandler(): void {
    if (this.liveHandlerRegistered) return;
    this.client.addEventHandler((update: unknown) => {
      void this.handleRawUpdate(update);
    }, this.liveBuilder);
    this.liveHandlerRegistered = true;
  }

  private async synchronize(state: EngineChannelState, reason: 'startup' | 'reconnect' | 'gap'): Promise<void> {
    if (state.recovery !== undefined) {
      await state.recovery;
      return;
    }
    state.recovery = this.runSynchronization(state, reason)
      .catch(async (error) => {
        const message = errorReason(error);
        state.sync = this.syncStates.markError(state.accountId, state.channel.id, message);
        this.logger.error({ account: this.accountKey, channel: state.channel.id, action: 'telegram_channel_sync', status: 'failed', reason, errorReason: message }, 'Telegram channel synchronization failed');
        await Promise.allSettled([...state.listeners.values()].map(async (listener) => listener.onError(error)));
      })
      .finally(() => {
        delete state.recovery;
      });
    await state.recovery;
  }

  private async runSynchronization(
    state: EngineChannelState,
    reason: 'startup' | 'reconnect' | 'gap',
  ): Promise<void> {
    void reason;
    state.sync = this.syncStates.markSyncing(state.accountId, state.channel.id);
    let pts = Math.max(1, state.sync.pts);

    for (;;) {
      const difference = await this.client.invoke(new Api.updates.GetChannelDifference({
        channel: utils.getInputChannel(state.entity),
        filter: new Api.ChannelMessagesFilterEmpty(),
        pts,
        limit: 100,
        force: true,
      }));

      if (difference instanceof Api.updates.ChannelDifferenceEmpty) {
        state.sync = this.syncStates.markHealthy(state.accountId, state.channel.id, difference.pts);
        return;
      }

      if (difference instanceof Api.updates.ChannelDifferenceTooLong) {
        const nextPts = difference.dialog instanceof Api.Dialog ? difference.dialog.pts ?? pts : pts;
        state.sync = this.syncStates.markHealthy(state.accountId, state.channel.id, nextPts);
        return;
      }

      pts = difference.pts;
      state.sync = this.syncStates.markHealthy(state.accountId, state.channel.id, pts);
      if (difference.final) {
        return;
      }
    }
  }

  private async handleRawUpdate(update: unknown): Promise<void> {
    if (update instanceof Api.UpdateChannelTooLong) {
      const state = this.channels.get(update.channelId.toString());
      if (state === undefined) return;
      state.sync = this.syncStates.markDegraded(state.accountId, state.channel.id, 'channel_too_long');
      await this.synchronize(state, 'gap');
      return;
    }

    if (!(update instanceof Api.UpdateNewChannelMessage) || !(update.message instanceof Api.Message)) return;
    if (!(update.message.peerId instanceof Api.PeerChannel)) return;

    const state = this.channels.get(update.message.peerId.channelId.toString());
    if (state === undefined) return;

    if (state.sync.syncStatus !== 'healthy') {
      await this.synchronize(state, 'gap');
      if (mapHealth(state.sync.syncStatus) !== 'HEALTHY') return;
    }

    const mapped = await mapGramJsEvent(newEngineEvent(update.message, update), state.entity);
    if (mapped.chatKind !== 'channel_post') return;

    state.sync = this.syncStates.markHealthy(state.accountId, state.channel.id, update.pts);
    await Promise.allSettled([...state.listeners.values()].map(async (listener) => listener.onLivePost(mapped)));
  }
}

function newEngineEvent(message: Api.Message, update: Api.UpdateNewChannelMessage): NewMessageLikeEvent {
  return {
    message,
    originalUpdate: update,
  } as NewMessageLikeEvent;
}

type NewMessageLikeEvent = Parameters<typeof mapGramJsEvent>[0];

function mapHealth(status: TelegramChannelSyncStatus): TelegramEngineChannelHealth {
  switch (status) {
    case 'connecting':
      return 'CONNECTING';
    case 'syncing':
    case 'pending':
      return 'SYNCING';
    case 'healthy':
      return 'HEALTHY';
    case 'degraded':
      return 'DEGRADED';
    case 'error':
      return 'ERROR';
    case 'disconnected':
      return 'DISCONNECTED';
  }
}
