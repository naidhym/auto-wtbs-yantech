import { Api, TelegramClient, utils } from 'telegram';
import { Raw } from 'telegram/events/index.js';

import type { ChannelRecord } from '../channels/channel.types.js';
import type { AppLogger } from '../logging/logger.js';
import type { TelegramIncomingMessage } from '../rules/rule.types.js';
import { errorReason } from '../logging/logger.js';
import { mapGramJsEvent, resolveBroadcastChannel } from './gramjs-client.service.js';
import {
  TelegramChannelSyncStateStore,
  type TelegramChannelSyncStateRecord,
} from './telegram-channel-sync-state.store.js';

export interface TelegramEngineSubscription {
  readonly assignmentId: number;
  readonly accountId: number;
  readonly accountKey: string;
  readonly channel: ChannelRecord;
  readonly identifier: string;
  readonly onLivePost: (event: TelegramIncomingMessage) => Promise<void>;
  readonly onError: (error: unknown) => Promise<void> | void;
}

export interface TelegramEngineStatus {
  readonly accountKey: string;
  readonly connected: boolean;
  readonly syncedChannels: number;
  readonly degradedChannels: number;
}

interface EngineChannelState {
  readonly entity: Api.Channel;
  readonly channel: ChannelRecord;
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
    private readonly syncStates: TelegramChannelSyncStateStore,
    _logger: AppLogger,
  ) {
    void _logger;
  }

  public async subscribe(input: TelegramEngineSubscription): Promise<() => Promise<void>> {
    const identifier = input.identifier;
    const entity = await resolveBroadcastChannel(this.client, identifier);
    const channelKey = entity.id.toString();
    const existing = this.channels.get(channelKey);
    const sync = this.syncStates.ensure(input.accountId, input.channel.id);
    const state: EngineChannelState = existing ?? {
      entity,
      channel: input.channel,
      listeners: new Map<number, TelegramEngineSubscription>(),
      sync,
    };
    state.listeners.set(input.assignmentId, input);
    state.sync = sync;
    this.channels.set(channelKey, state);
    this.ensureLiveHandler();
    await this.synchronize(state);

    return () => {
      const current = this.channels.get(channelKey);
      if (current !== undefined) {
        current.listeners.delete(input.assignmentId);
        if (current.listeners.size === 0) {
          this.channels.delete(channelKey);
        }
      }
      return Promise.resolve();
    };
  }

  public getStatus(): TelegramEngineStatus {
    const states = [...this.channels.values()].map((state) => state.sync);
    return {
      accountKey: this.accountKey,
      connected: this.client.connected === true,
      syncedChannels: states.filter((state) => state.syncStatus === 'healthy').length,
      degradedChannels: states.filter((state) => state.syncStatus !== 'healthy').length,
    };
  }

  private ensureLiveHandler(): void {
    if (this.liveHandlerRegistered) return;
    this.client.addEventHandler((update: unknown) => {
      void this.handleRawUpdate(update);
    }, this.liveBuilder);
    this.liveHandlerRegistered = true;
  }

  private async synchronize(state: EngineChannelState): Promise<void> {
    if (state.recovery !== undefined) {
      await state.recovery;
      return;
    }
    state.recovery = this.runSynchronization(state)
      .catch(async (error) => {
        state.sync = this.syncStates.markError(state.sync.accountId, state.sync.channelId, errorReason(error));
        await Promise.allSettled([...state.listeners.values()].map(async (listener) => listener.onError(error)));
      })
      .finally(() => {
        delete state.recovery;
      });
    await state.recovery;
  }

  private async runSynchronization(state: EngineChannelState): Promise<void> {
    state.sync = this.syncStates.markRecovering(state.sync.accountId, state.sync.channelId);
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
        state.sync = this.syncStates.markHealthy(state.sync.accountId, state.sync.channelId, difference.pts);
        return;
      }

      if (difference instanceof Api.updates.ChannelDifferenceTooLong) {
        const nextPts = difference.dialog instanceof Api.Dialog ? difference.dialog.pts ?? pts : pts;
        state.sync = this.syncStates.markHealthy(state.sync.accountId, state.sync.channelId, nextPts);
        return;
      }

      pts = difference.pts;
      state.sync = this.syncStates.markHealthy(state.sync.accountId, state.sync.channelId, pts);
      if (difference.final) {
        return;
      }
    }
  }

  private async handleRawUpdate(update: unknown): Promise<void> {
    if (update instanceof Api.UpdateChannelTooLong) {
      const state = this.channels.get(update.channelId.toString());
      if (state === undefined) return;
      await this.synchronize(state);
      return;
    }

    if (!(update instanceof Api.UpdateNewChannelMessage) || !(update.message instanceof Api.Message)) {
      return;
    }
    if (!(update.message.peerId instanceof Api.PeerChannel)) {
      return;
    }
    const channelKey = update.message.peerId.channelId.toString();
    const state = this.channels.get(channelKey);
    if (state === undefined) return;
    if (state.sync.syncStatus !== 'healthy') {
      await this.synchronize(state);
      return;
    }

    const mapped = await mapGramJsEvent(newEngineEvent(update.message, update), state.entity);
    if (mapped.chatKind !== 'channel_post') {
      return;
    }
    state.sync = this.syncStates.markHealthy(state.sync.accountId, state.sync.channelId, update.pts);
    await Promise.allSettled([...state.listeners.values()].map(async (listener) => {
      await listener.onLivePost(mapped);
    }));
  }
}

function newEngineEvent(message: Api.Message, update: Api.UpdateNewChannelMessage): NewMessageLikeEvent {
  return {
    message,
    originalUpdate: update,
  } as NewMessageLikeEvent;
}

type NewMessageLikeEvent = Parameters<typeof mapGramJsEvent>[0];
