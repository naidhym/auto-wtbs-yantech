import { Api, TelegramClient, utils } from 'telegram';
import { Raw } from 'telegram/events/index.js';

import type { ChannelRecord } from '../channels/channel.types.js';
import { errorReason, type AppLogger } from '../logging/logger.js';
import type { TelegramIncomingMessage } from '../rules/rule.types.js';
import { mapGramJsEvent, resolveBroadcastChannel } from './gramjs-client.service.js';
import { canonicalTelegramChannelId } from './telegram-channel-id.js';
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

// TEMPORARY ROOT-CAUSE DIAGNOSTIC payload — observability only.
interface NativeUpdateDiagnostic {
  readonly updateClass: string;
  readonly peerClass: string;
  readonly extractedChannelId?: string | undefined;
  readonly extractedUserId?: string | undefined;
  readonly messageId?: number | undefined;
  readonly broadcast: boolean | string;
  readonly megagroup: boolean | string;
  readonly out: boolean | string;
  readonly post: boolean | string;
  readonly registered: boolean;
  readonly matchedChannelId?: number | undefined;
  readonly registeredChannels: readonly string[];
  readonly classification: string;
  readonly dropReason: string;
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
  private readonly liveBuilder = new Raw({
    types: [Api.UpdateNewChannelMessage, Api.UpdateNewMessage, Api.UpdateChannelTooLong],
  });
  private liveHandlerRegistered = false;

  // ===========================================================================
  // TEMPORARY ROOT-CAUSE DIAGNOSTIC — see task brief.
  // This is OBSERVABILITY ONLY. It does NOT change the update pipeline or any
  // filtering/classification. It registers a SECOND, broader Raw handler on the
  // same client so we can see EVERY relevant native Telegram update BEFORE the
  // production liveBuilder narrows them down. Remove this block (field +
  // ensureDiagnosticHandler + logNativeUpdate + extractNativeUpdateDiagnostics)
  // once the production trace is collected.
  // Never logs: message text/body, session, API credentials, bot token, login
  // code, or access hash.
  // ===========================================================================
  private diagnosticHandlerRegistered = false;

  public constructor(
    private readonly accountKey: string,
    private readonly client: TelegramClient,
    private readonly syncStates: TelegramChannelSyncStateRepository,
    private readonly logger: AppLogger,
  ) {}

  public async subscribe(input: TelegramEngineSubscription): Promise<() => Promise<void>> {
    const entity = await resolveBroadcastChannel(this.client, input.identifier);
    const channelKey = canonicalTelegramChannelId(entity.id);
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
      telegramChannelId: canonicalTelegramChannelId(state.entity.id),
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
    this.ensureDiagnosticHandler();
  }

  // TEMPORARY ROOT-CAUSE DIAGNOSTIC — see banner above the diagnostic field.
  private ensureDiagnosticHandler(): void {
    if (this.diagnosticHandlerRegistered) return;
    this.diagnosticHandlerRegistered = true;

    const diagBuilder = new Raw({
      types: [
        Api.UpdateNewChannelMessage,
        Api.UpdateNewMessage,
        Api.UpdateChannelTooLong,
        Api.Updates,
        Api.UpdatesCombined,
      ],
    });
    this.client.addEventHandler((update: unknown) => {
      void this.logNativeUpdate(update);
    }, diagBuilder);
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
      const lookupKey = canonicalTelegramChannelId(update.channelId);
      const state = this.channels.get(lookupKey);
      if (state === undefined) return;
      state.sync = this.syncStates.markDegraded(state.accountId, state.channel.id, 'channel_too_long');
      await this.synchronize(state, 'gap');
      return;
    }
    // Native posts arrive as UpdateNewChannelMessage for broadcast channels and
    // as UpdateNewMessage for megagroups/supergroups. Accept both so supergroup
    // monitoring is not filtered out before classification.
    if (
      !(update instanceof Api.UpdateNewChannelMessage) &&
      !(update instanceof Api.UpdateNewMessage)
    ) return;
    if (!(update.message instanceof Api.Message)) return;

    if (!(update.message.peerId instanceof Api.PeerChannel)) return;

    const lookupKey = canonicalTelegramChannelId(update.message.peerId.channelId);
    const state = this.channels.get(lookupKey);
    
    if (state === undefined) {
      // Log the mismatch for debugging
      this.logger.debug(
        {
          account: this.accountKey,
          action: 'telegram_update_registry_miss',
          status: 'not_found',
          extractedChannelId: lookupKey,
          registeredChannels: Array.from(this.channels.keys()),
          messageId: update.message.id,
        },
        'Native update received for unregistered channel',
      );
      return;
    }

    // A live, classifiable post that reaches this handler for a registered
    // channel is itself proof the account can receive it. Re-attempt the
    // background diff-sync (to keep pts state current) but do NOT discard the
    // live post when that sync is unhealthy. This is the exact failure mode that
    // affects private WTB megagroups (whose initial GetChannelDifference can fail
    // while the account is still a valid participant) but NOT the public test
    // channel, whose sync is healthy from the start.
    if (state.sync.syncStatus !== 'healthy') {
      await this.synchronize(state, 'gap');
    }

    const mapped = await mapGramJsEvent(newEngineEvent(update.message, update), state.entity);
    if (mapped.chatKind !== 'channel_post' && mapped.chatKind !== 'supergroup') return;

    state.sync = this.syncStates.markHealthy(state.accountId, state.channel.id, update.pts);
    await Promise.allSettled([...state.listeners.values()].map(async (listener) => listener.onLivePost(mapped)));
  }

  // ===========================================================================
  // TEMPORARY ROOT-CAUSE DIAGNOSTIC — OBSERVABILITY ONLY, no behaviour change.
  // Logs every relevant native update BEFORE the production filter acts on it.
  // ===========================================================================
  private logNativeUpdate(update: unknown): void {
    try {
      const diag = this.extractNativeUpdateDiagnostics(update);
      if (diag === undefined) return;
      this.logger.info(
        {
          account: this.accountKey,
          action: 'diag_native_update',
          status: 'received',
          updateClass: diag.updateClass,
          peerClass: diag.peerClass,
          extractedChannelId: diag.extractedChannelId,
          extractedUserId: diag.extractedUserId,
          messageId: diag.messageId,
          broadcast: diag.broadcast,
          megagroup: diag.megagroup,
          out: diag.out,
          post: diag.post,
          registered: diag.registered,
          matchedChannelId: diag.matchedChannelId,
          registeredChannels: diag.registeredChannels,
          classification: diag.classification,
          dropReason: diag.dropReason,
        },
        '[TEMP-DIAG] native telegram update received',
      );
    } catch {
      // Diagnostics must never break the real pipeline.
    }
  }

  private extractNativeUpdateDiagnostics(update: unknown): NativeUpdateDiagnostic | undefined {
    if (update instanceof Api.UpdateChannelTooLong) {
      const extractedChannelId = canonicalTelegramChannelId(update.channelId);
      const state = this.channels.get(extractedChannelId);
      const registered = state !== undefined;
      return {
        updateClass: 'UpdateChannelTooLong',
        peerClass: 'PeerChannel',
        extractedChannelId,
        extractedUserId: undefined,
        messageId: undefined,
        broadcast: 'n/a',
        megagroup: 'n/a',
        out: 'n/a',
        post: 'n/a',
        registered,
        matchedChannelId: state?.channel.id,
        registeredChannels: this.registeredChannelKeys(),
        classification: 'n/a',
        dropReason: registered ? 'gap_recovery_triggered' : 'registry_miss',
      };
    }

    if (update instanceof Api.UpdateNewChannelMessage || update instanceof Api.UpdateNewMessage) {
      const message = update.message;
      if (!(message instanceof Api.Message)) return undefined;

      const peer = message.peerId;
      let extractedChannelId: string | undefined;
      let extractedUserId: string | undefined;
      let peerClass = 'unknown';
      if (peer instanceof Api.PeerChannel) {
        extractedChannelId = canonicalTelegramChannelId(peer.channelId);
        peerClass = 'PeerChannel';
      } else if (peer instanceof Api.PeerUser) {
        extractedUserId = String(peer.userId);
        peerClass = 'PeerUser';
      } else if (peer instanceof Api.PeerChat) {
        peerClass = 'PeerChat';
      }

      // Only channel-relevant posts are worth logging; skip private/user chats.
      if (extractedChannelId === undefined) return undefined;

      let broadcast: boolean | string = 'n/a';
      let megagroup: boolean | string = 'n/a';
      const chat = message.chat;
      if (chat instanceof Api.Channel) {
        broadcast = chat.broadcast ?? 'n/a';
        megagroup = chat.megagroup ?? 'n/a';
      }

      const updateClass = update instanceof Api.UpdateNewChannelMessage ? 'UpdateNewChannelMessage' : 'UpdateNewMessage';
      const state = this.channels.get(extractedChannelId);
      const registered = state !== undefined;
      const classification = updateClass === 'UpdateNewChannelMessage'
        ? 'channel_post'
        : peerClass === 'PeerChannel'
          ? 'supergroup'
          : 'unknown';

      let dropReason: string;
      if (!registered) {
        dropReason = 'registry_miss';
      } else if (state === undefined || state.sync.syncStatus !== 'healthy') {
        dropReason = 'sync_recovery_then_reevaluate';
      } else {
        dropReason = 'would_emit_if_chatKind_channel_post_or_supergroup';
      }

      return {
        updateClass,
        peerClass,
        extractedChannelId,
        extractedUserId,
        messageId: message.id,
        broadcast,
        megagroup,
        out: message.out ?? 'n/a',
        post: message.post ?? 'n/a',
        registered,
        matchedChannelId: state?.channel.id,
        registeredChannels: this.registeredChannelKeys(),
        classification,
        dropReason,
      };
    }

    if (update instanceof Api.Updates || update instanceof Api.UpdatesCombined) {
      const inner = (update as { updates?: unknown[] }).updates;
      if (Array.isArray(inner)) {
        for (const sub of inner) {
          void this.logNativeUpdate(sub);
        }
      }
      return undefined;
    }

    return undefined;
  }

  private registeredChannelKeys(): readonly string[] {
    return Array.from(this.channels.keys());
  }
}

function newEngineEvent(message: Api.Message, update: Api.UpdateNewChannelMessage | Api.UpdateNewMessage): NewMessageLikeEvent {
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
