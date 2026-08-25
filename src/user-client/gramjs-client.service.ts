import { Api, TelegramClient, utils } from 'telegram';
import type { UserAuthParams } from 'telegram/client/auth.js';
import { NewMessage, NewMessageEvent, Raw } from 'telegram/events/index.js';
import { LogLevel } from 'telegram/extensions/Logger.js';
import { StringSession } from 'telegram/sessions/index.js';
import { _handleUpdate } from 'telegram/client/updates.js';

import type {
  ResolvedTelegramChannel,
  TelegramChannelSubscriptionContext,
} from '../channels/channel.types.js';
import type { TelegramIncomingMessage, TelegramSenderDisplayName } from '../rules/rule.types.js';
import { errorReason, type AppLogger } from '../logging/logger.js';

export type TelegramClientState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'reconnecting'
  | 'error';

export interface SentTelegramComment {
  readonly messageId: number;
  resolveMessageLink(): Promise<string>;
  reactToOwnComment(): Promise<TelegramReactionResult>;
}

export interface TelegramReactionResult {
  readonly status: 'sent' | 'skipped';
  readonly reason?: string;
}

export interface TelegramOperationalNotification {
  readonly text: string;
  readonly link?: {
    readonly label: string;
    readonly url: string;
  };
}

export interface TelegramClientAdapter {
  readonly connected: boolean | undefined;
  connect(): Promise<boolean>;
  disconnect(): Promise<void>;
  destroy(): Promise<void>;
  start(authParams: UserAuthParams): Promise<void>;
  checkAuthorization(): Promise<boolean>;
  saveSession(): string;
  getTelegramUserId(): Promise<string | undefined>;
  resolveChannel(identifier: string): Promise<ResolvedTelegramChannel>;
  subscribeChannel(
    identifier: string,
    context: TelegramChannelSubscriptionContext,
    onMessage: (event: TelegramIncomingMessage) => Promise<void>,
    onError: (error: unknown) => Promise<void> | void,
  ): Promise<() => Promise<void>>;
  sendChannelComment(
    identifier: string,
    sourceMessageId: number,
    text: string,
  ): Promise<SentTelegramComment>;
  sendOperationalNotification(
    target: string,
    notification: TelegramOperationalNotification,
  ): Promise<void>;
  setBackgroundErrorHandler?(handler: (error: unknown) => Promise<void>): void;
}

export interface GramJsClientOptions {
  readonly accountKey: string;
  readonly apiId: number;
  readonly apiHash: string;
  readonly session?: string;
  readonly connectionRetries?: number;
  readonly reconnectRetries?: number;
  /** Used only by read-only diagnostics so GramJS transport chatter does not pollute terminal output. */
  readonly silent?: boolean;
}

export interface TelegramClientStatus {
  readonly accountKey: string;
  readonly state: TelegramClientState;
  readonly connected: boolean;
  readonly lastError?: string;
  readonly updatedAt: string;
}

export type TelegramClientFactory = (
  options: GramJsClientOptions,
  logger?: AppLogger,
  nativeClientInstanceId?: string,
) => TelegramClientAdapter;

let nextDiagnosticCorrelationId = 1;

const defaultClientFactory: TelegramClientFactory = (options, logger, nativeClientInstanceId = 'unavailable') => {
  const session = new StringSession(options.session ?? '');
  const client = new TelegramClient(
    session,
    options.apiId,
    options.apiHash,
    {
      autoReconnect: true,
      connectionRetries: options.connectionRetries ?? 5,
      reconnectRetries: options.reconnectRetries ?? 3,
      requestRetries: 5,
    },
  );
  if (options.silent === true) {
    client.setLogLevel(LogLevel.NONE);
  }
  let backgroundErrorHandler: (error: unknown) => Promise<void> = () => Promise.resolve();
  let listenerRegistrationCount = 0;
  const reportBackgroundError = async (error: unknown): Promise<void> => {
    try {
      await backgroundErrorHandler(error);
    } catch (reportingError) {
      client.logger.error(
        `Background error handler failed: ${errorReason(reportingError)}; original: ${errorReason(error)}`,
      );
    }
  };
  client.onError = reportBackgroundError;
  const nativeUpdateObserver = (update: unknown): void => {
    if (!(update instanceof Api.UpdateNewChannelMessage) || !(update.message instanceof Api.Message)) {
      return;
    }
    const peer = update.message.peerId;
    logger?.info(
      {
        account: options.accountKey,
        action: 'diagnostic_native_telegram_update',
        status: 'received',
        nativeClientInstanceId,
        updateType: update.constructor.name,
        rawPeerType: peer?.constructor.name,
        ...(peer instanceof Api.PeerChannel ? { actualTelegramChannelId: peer.channelId.toString() } : {}),
        sourceMessageId: update.message.id,
        post: update.message.post === true,
      },
      'Native Telegram channel update observed before NewMessage filtering',
    );
  };
  client.addEventHandler(nativeUpdateObserver, new Raw({ types: [Api.UpdateNewChannelMessage] }));
  logger?.info(
    {
      account: options.accountKey,
      action: 'diagnostic_native_update_observer_registration',
      status: 'registered',
      nativeClientInstanceId,
      eventBuilderType: 'Raw',
      eventBuilderFilter: 'Api.UpdateNewChannelMessage',
    },
    'Native Telegram update observer registered before NewMessage filtering',
  );

  return {
    get connected(): boolean | undefined {
      return client.connected;
    },
    async connect(): Promise<boolean> {
      return client.connect();
    },
    async disconnect(): Promise<void> {
      await client.disconnect();
    },
    async destroy(): Promise<void> {
      await client.destroy();
    },
    async start(authParams): Promise<void> {
      await client.start(authParams);
    },
    async checkAuthorization(): Promise<boolean> {
      return client.checkAuthorization();
    },
    saveSession(): string {
      return session.save();
    },
    async getTelegramUserId(): Promise<string | undefined> {
      const user = await client.getMe();
      return user.id?.toString();
    },
    async resolveChannel(identifier): Promise<ResolvedTelegramChannel> {
      const entity = await resolveBroadcastChannel(client, identifier);
      const adminRights = permissionNames(entity.adminRights);
      const defaultBannedRights = permissionNames(entity.defaultBannedRights);
      return {
        telegramChannelId: entity.id.toString(),
        ...(entity.username === undefined ? {} : { username: entity.username }),
        title: entity.title,
        left: entity.left === true,
        broadcast: entity.broadcast === true,
        megagroup: entity.megagroup === true,
        restricted: entity.restricted === true,
        creator: entity.creator === true,
        entityType: entity.constructor.name,
        ...(adminRights === undefined ? {} : { adminRights }),
        ...(defaultBannedRights === undefined ? {} : { defaultBannedRights }),
      };
    },
    async subscribeChannel(
      identifier,
      context,
      onMessage,
      onError,
    ): Promise<() => Promise<void>> {
      let entity: Api.Channel;
      try {
        entity = await resolveBroadcastChannel(client, identifier);
      } catch (error) {
        logger?.warn(
          diagnosticFields(context, nativeClientInstanceId, {
            action: 'diagnostic_telegram_entity_resolution',
            status: 'failed',
            errorName: error instanceof Error ? error.name : 'UnknownError',
            errorMessage: errorReason(error),
          }),
          'Telegram entity resolution diagnostic failed',
        );
        throw error;
      }
      const diagnostic = (
        action: string,
        status: string,
        reason: string,
        actualTelegramChannelId?: string,
        sourceMessageId?: number,
        extra: Record<string, unknown> = {},
      ): void => {
        logger?.info(
          {
            account: context.accountSessionKey,
            channel: context.channelId,
            action,
            status,
            reason,
            ...diagnosticFields(context, nativeClientInstanceId),
            ...(actualTelegramChannelId === undefined ? {} : { actualTelegramChannelId }),
            nativeClientInstanceId,
            ...(sourceMessageId === undefined ? {} : { sourceMessageId }),
            ...extra,
          },
          'Telegram listener diagnostic',
        );
      };
      diagnostic(
        'diagnostic_telegram_entity_resolution',
        entity.id.toString() === context.expectedTelegramChannelId ? 'success' : 'mismatch',
        entity.id.toString() === context.expectedTelegramChannelId
          ? 'broadcast_channel_resolved'
          : 'resolved_entity_id_differs_from_expected_channel_id',
        entity.id.toString(),
        undefined,
        {
          usernameUsedForResolution: context.usernameUsedForResolution,
          resolvedEntityType: entity.constructor.name,
          expectedMatchesActual: entity.id.toString() === context.expectedTelegramChannelId,
          resolvedBroadcast: entity.broadcast === true,
          resolvedMegagroup: entity.megagroup === true,
          resolvedLeft: entity.left === true,
          resolvedRestricted: entity.restricted === true,
          resolvedCreator: entity.creator === true,
          resolvedAdminRights: permissionNames(entity.adminRights),
          resolvedDefaultBannedRights: permissionNames(entity.defaultBannedRights),
        },
      );
      const builder = createChannelMessageBuilder(entity.id.toString());
      await builder.resolve(client);
      let channelRecoveryInFlight: Promise<void> | undefined;
      const channelRecoveryBuilder = new Raw({ types: [Api.UpdateChannelTooLong] });
      const channelRecoveryHandler = (update: unknown): void => {
        if (
          !(update instanceof Api.UpdateChannelTooLong) ||
          update.channelId.toString() !== entity.id.toString() ||
          channelRecoveryInFlight !== undefined
        ) {
          return;
        }

        channelRecoveryInFlight = recoverChannelUpdateState(client, entity, update)
          .then(() => undefined)
          .catch(reportBackgroundError)
          .finally(() => {
            channelRecoveryInFlight = undefined;
          });
      };
      client.addEventHandler(channelRecoveryHandler, channelRecoveryBuilder);
      const handler = (event: NewMessageEvent): void => {
        void (async () => {
          const correlationId = `upd-${nextDiagnosticCorrelationId++}`;
          const actualTelegramChannelId = telegramChannelIdFromEvent(event);
          const sourceMessageId = event.message.id;
          diagnostic(
            'diagnostic_raw_telegram_update',
            'received',
            'native_new_message_handler_invoked',
            actualTelegramChannelId,
            sourceMessageId,
            rawUpdateMetadata(event, entity, correlationId),
          );
          try {
            const mappedMessage = await mapGramJsEvent(event, entity);
            const scoped = mappedMessage.chatKind === 'channel_post' &&
              mappedMessage.telegramChannelId === context.expectedTelegramChannelId;
            diagnostic(
              'diagnostic_scoped_channel_guard',
              scoped ? 'passed' : 'ignored',
              scoped
                ? 'accepted'
                : scopedChannelReason(mappedMessage, context.expectedTelegramChannelId),
              mappedMessage.telegramChannelId ?? actualTelegramChannelId,
              mappedMessage.sourceMessageId,
              { correlationId, accepted: scoped },
            );
            diagnostic(
              'diagnostic_mapper',
              'mapped',
              `chat_kind:${mappedMessage.chatKind}`,
              mappedMessage.telegramChannelId ?? actualTelegramChannelId,
              mappedMessage.sourceMessageId,
              { correlationId, telegramChannelId: mappedMessage.telegramChannelId },
            );
            await onMessage({ ...mappedMessage, correlationId });
          } catch (error) {
            diagnostic(
              'diagnostic_mapper',
              'failed',
              errorReason(error),
              actualTelegramChannelId,
              sourceMessageId,
              {
                correlationId,
                errorName: error instanceof Error ? error.name : 'UnknownError',
                errorMessage: errorReason(error),
              },
            );
            try {
              await onError(error);
            } catch (boundaryError) {
              await reportBackgroundError(boundaryError);
            }
          }
        })();
      };
      client.addEventHandler(handler, builder);
      listenerRegistrationCount += 1;
      diagnostic(
        'diagnostic_listener_registration',
        'registered',
        'native_gramjs_handler_registered',
        entity.id.toString(),
        undefined,
        {
          resolvedTelegramChannelId: entity.id.toString(),
          telegramChannelId: context.expectedTelegramChannelId,
          eventBuilderType: builder.constructor.name,
          eventBuilderChats: builder.chats,
          eventBuilderResolved: builder.resolved,
          registrationIndex: listenerRegistrationCount + 1,
          handlerRegistrationCount: listenerRegistrationCount + 1,
        },
      );
      return (): Promise<void> => {
        client.removeEventHandler(handler, builder);
        client.removeEventHandler(channelRecoveryHandler, channelRecoveryBuilder);
        listenerRegistrationCount -= 1;
        diagnostic(
          'diagnostic_listener_registration',
          'removed',
          'native_gramjs_handler_removed',
          entity.id.toString(),
          undefined,
          { handlerRegistrationCount: listenerRegistrationCount },
        );
        return Promise.resolve();
      };
    },
    async sendChannelComment(identifier, sourceMessageId, text) {
      const entity = await resolveBroadcastChannel(client, identifier);
      const sent = await client.sendMessage(entity, {
        message: text,
        commentTo: sourceMessageId,
        linkPreview: false,
      });
      return {
        messageId: sent.id,
        resolveMessageLink: () => buildTelegramMessageLink(sent),
        reactToOwnComment: async () => {
          if (sent.peerId === undefined) {
            return { status: 'skipped', reason: 'reply_peer_unavailable' };
          }
          return reactToSentComment(client, sent.peerId, sent.id);
        },
      };
    },
    async sendOperationalNotification(target, notification) {
      await client.sendMessage(target, createTelegramNotificationPayload(notification));
    },
    setBackgroundErrorHandler(handler): void {
      backgroundErrorHandler = handler;
    },
  };
};

export class GramJsClientService {
  private static nextNativeClientInstance = 1;
  private readonly client: TelegramClientAdapter;
  private readonly nativeClientInstanceId: string;
  private state: TelegramClientState = 'disconnected';
  private lastError: string | undefined;
  private updatedAt = new Date().toISOString();
  private operation: Promise<void> = Promise.resolve();

  public constructor(
    private readonly options: GramJsClientOptions,
    private readonly logger: AppLogger,
    clientFactory: TelegramClientFactory = defaultClientFactory,
  ) {
    this.nativeClientInstanceId = `gramjs-${GramJsClientService.nextNativeClientInstance++}`;
    this.client = clientFactory(options, logger, this.nativeClientInstanceId);
    this.client.setBackgroundErrorHandler?.((error) => {
      this.lastError = errorReason(error);
      if (this.client.connected !== true && this.state === 'connected') {
        this.setState('error');
      }
      this.logger.warn(
        {
          account: this.options.accountKey,
          action: 'telegram_client_background_error',
          status: 'contained',
          errorReason: this.lastError,
        },
        'Telegram client background error was contained',
      );
      return Promise.resolve();
    });
  }

  public connect(): Promise<TelegramClientStatus> {
    return this.enqueue(async () => this.connectInternal('connecting'));
  }

  public disconnect(): Promise<TelegramClientStatus> {
    return this.enqueue(async () => this.disconnectInternal());
  }

  public reconnect(): Promise<TelegramClientStatus> {
    return this.enqueue(async () => {
      this.setState('reconnecting');
      await this.disconnectInternal(false);
      return this.connectInternal('reconnecting');
    });
  }

  public authenticate(authParams: UserAuthParams): Promise<TelegramClientStatus> {
    return this.enqueue(async () => {
      this.setState('connecting');

      try {
        await this.client.start(authParams);

        if (!(await this.client.checkAuthorization())) {
          throw new Error('Telegram authorization did not produce a valid session');
        }

        this.lastError = undefined;
        this.setState('connected');
        return this.getStatus();
      } catch (error) {
        this.lastError = errorReason(error);
        this.setState('error');
        throw error;
      }
    });
  }

  public isAuthorized(): Promise<boolean> {
    return this.enqueue(async () => this.client.checkAuthorization());
  }

  public exportSession(): string {
    return this.client.saveSession();
  }

  public getTelegramUserId(): Promise<string | undefined> {
    return this.enqueue(async () => this.client.getTelegramUserId());
  }

  public getNativeClientInstanceId(): string {
    return this.nativeClientInstanceId;
  }

  public resolveChannel(identifier: string): Promise<ResolvedTelegramChannel> {
    return this.enqueue(async () => {
      if (!this.getStatus().connected) throw new Error('Telegram client is not connected');
      return this.client.resolveChannel(identifier);
    });
  }

  public subscribeChannel(
    identifier: string,
    context: TelegramChannelSubscriptionContext,
    onMessage: (event: TelegramIncomingMessage) => Promise<void>,
    onError: (error: unknown) => Promise<void> | void,
  ): Promise<() => Promise<void>> {
    return this.enqueue(async () => {
      if (!this.getStatus().connected) throw new Error('Telegram client is not connected');
      return this.client.subscribeChannel(
        identifier,
        context,
        async (event) => onMessage({ ...event, nativeClientInstanceId: this.nativeClientInstanceId }),
        onError,
      );
    });
  }

  public sendChannelComment(
    identifier: string,
    sourceMessageId: number,
    text: string,
  ): Promise<SentTelegramComment> {
    return this.enqueue(async () => {
      if (!this.getStatus().connected) throw new Error('Telegram client is not connected');
      return this.client.sendChannelComment(identifier, sourceMessageId, text);
    });
  }

  public sendOperationalNotification(
    target: string,
    notification: TelegramOperationalNotification,
  ): Promise<void> {
    return this.enqueue(async () => {
      if (!this.getStatus().connected) throw new Error('Telegram client is not connected');
      await this.client.sendOperationalNotification(target, notification);
    });
  }

  public async abort(): Promise<void> {
    try {
      await this.client.destroy();
    } finally {
      this.setState('disconnected');
    }
  }

  public destroy(): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.client.destroy();
      } finally {
        this.lastError = undefined;
        this.setState('disconnected');
      }
    });
  }

  public getStatus(): TelegramClientStatus {
    return {
      accountKey: this.options.accountKey,
      state: this.state,
      connected: this.client.connected === true && this.state === 'connected',
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      updatedAt: this.updatedAt,
    };
  }

  private async connectInternal(
    transitionState: 'connecting' | 'reconnecting',
  ): Promise<TelegramClientStatus> {
    if (this.client.connected === true && this.state === 'connected') {
      return this.getStatus();
    }

    this.setState(transitionState);

    try {
      const connected = await this.client.connect();

      if (!connected && this.client.connected !== true) {
        throw new Error('GramJS client did not establish a connection');
      }

      this.lastError = undefined;
      this.setState('connected');
      this.logger.info(
        {
          account: this.options.accountKey,
          action: 'telegram_client_connect',
          status: 'connected',
        },
        'Telegram client connected',
      );
      return this.getStatus();
    } catch (error) {
      this.lastError = errorReason(error);
      this.setState('error');
      this.logger.error(
        {
          account: this.options.accountKey,
          action: 'telegram_client_connect',
          status: 'failed',
          errorReason: this.lastError,
        },
        'Telegram client connection failed',
      );
      throw error;
    }
  }

  private async disconnectInternal(log = true): Promise<TelegramClientStatus> {
    if (this.client.connected !== true && this.state === 'disconnected') {
      return this.getStatus();
    }

    this.setState('disconnecting');

    try {
      await this.client.disconnect();
      this.lastError = undefined;
      this.setState('disconnected');

      if (log) {
        this.logger.info(
          {
            account: this.options.accountKey,
            action: 'telegram_client_disconnect',
            status: 'disconnected',
          },
          'Telegram client disconnected',
        );
      }

      return this.getStatus();
    } catch (error) {
      this.lastError = errorReason(error);
      this.setState('error');
      this.logger.error(
        {
          account: this.options.accountKey,
          action: 'telegram_client_disconnect',
          status: 'failed',
          errorReason: this.lastError,
        },
        'Telegram client disconnection failed',
      );
      throw error;
    }
  }

  private setState(state: TelegramClientState): void {
    this.state = state;
    this.updatedAt = new Date().toISOString();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export async function resolveBroadcastChannel(
  client: TelegramClient,
  identifier: string,
): Promise<Api.Channel> {
  let entity: unknown;
  let initialError: unknown;

  try {
    entity = await client.getEntity(identifier);
  } catch (error) {
    initialError = error;
  }

  if (!(entity instanceof Api.Channel) && /^-?\d+$/.test(identifier)) {
    const expectedId = identifier.startsWith('-100')
      ? identifier.slice(4)
      : identifier.replace(/^-/, '');
    for await (const dialog of client.iterDialogs({})) {
      if (dialog.entity instanceof Api.Channel && dialog.entity.id.toString() === expectedId) {
        entity = dialog.entity;
        break;
      }
    }
  }

  if (!(entity instanceof Api.Channel)) {
    if (initialError instanceof Error) throw initialError;
    if (initialError !== undefined) throw new Error(errorReason(initialError));
    throw new Error('Resolved Telegram entity is not a channel');
  }
  if (entity.broadcast !== true || entity.megagroup === true) {
    throw new Error('Resolved Telegram entity is not a broadcast channel');
  }
  return entity;
}

export function createChannelMessageBuilder(telegramChannelId: string): NewMessage {
  if (!/^\d+$/.test(telegramChannelId)) {
    throw new Error('Telegram channel ID must be numeric');
  }
  return new NewMessage({ chats: [telegramChannelId] });
}

/**
 * A numeric `NewMessage.chats` filter is local-only. When Telegram reports a
 * channel gap, acknowledge its latest pts with the channel's access-hash-backed
 * InputChannel so future live updates resume without replaying missed posts.
 */
export async function recoverChannelUpdateState(
  client: Pick<TelegramClient, 'invoke'>,
  entity: Api.Channel,
  update: unknown,
): Promise<boolean> {
  if (
    !(update instanceof Api.UpdateChannelTooLong) ||
    update.channelId.toString() !== entity.id.toString()
  ) {
    return false;
  }

  const channel = utils.getInputChannel(entity);
  let pts = update.pts ?? 1;

  for (;;) {
    const difference = await client.invoke(new Api.updates.GetChannelDifference({
      channel,
      filter: new Api.ChannelMessagesFilterEmpty(),
      pts,
      limit: 100,
      force: true,
    }));

    if (difference instanceof Api.updates.ChannelDifferenceEmpty) {
      return true;
    }

    if (difference instanceof Api.updates.ChannelDifferenceTooLong) {
      for (const differenceUpdate of buildChannelTooLongUpdates(difference)) {
        _handleUpdate(client as TelegramClient, differenceUpdate);
      }
      return true;
    }

    for (const differenceUpdate of [
      ...difference.otherUpdates,
      ...difference.newMessages.map((message) => new Api.UpdateNewChannelMessage({
        message,
        pts: difference.pts,
        ptsCount: 0,
      })),
    ]) {
      _handleUpdate(client as TelegramClient, differenceUpdate);
    }

    if (difference.final) {
      return true;
    }

    pts = difference.pts;
  }
}

function buildChannelTooLongUpdates(
  difference: Api.updates.ChannelDifferenceTooLong,
): Api.TypeUpdate[] {
  const pts = difference.dialog instanceof Api.Dialog ? difference.dialog.pts ?? 0 : 0;
  const updates: Api.TypeUpdate[] = [];
  for (const message of difference.messages) {
    if (message instanceof Api.Message) {
      updates.push(new Api.UpdateNewChannelMessage({
        message,
        pts,
        ptsCount: 0,
      }));
    }
  }
  return updates;
}

function permissionNames(rights: unknown): readonly string[] | undefined {
  if (typeof rights !== 'object' || rights === null) return undefined;
  const names = Object.entries(rights)
    .filter(([, value]) => value === true)
    .map(([name]) => name)
    .sort();
  return names;
}

export function evaluateHeartReactionCapability(
  availableReactions: Api.TypeChatReactions | undefined,
): { readonly supported: boolean; readonly reason?: string } {
  if (
    availableReactions === undefined ||
    availableReactions instanceof Api.ChatReactionsNone
  ) {
    return { supported: false, reason: 'chat_reactions_none' };
  }
  if (availableReactions instanceof Api.ChatReactionsAll) {
    return { supported: true };
  }
  const heartAvailable = availableReactions.reactions.some((reaction) =>
    reaction instanceof Api.ReactionEmoji && normalizeReactionEmoji(reaction.emoticon) === '❤'
  );
  return heartAvailable
    ? { supported: true }
    : { supported: false, reason: 'heart_reaction_unavailable' };
}

export function createHeartReactionRequest(
  peer: Api.TypeEntityLike,
  sourceMessageId: number,
): Api.messages.SendReaction {
  if (!Number.isSafeInteger(sourceMessageId) || sourceMessageId < 1) {
    throw new Error('Source channel message ID is invalid');
  }
  return new Api.messages.SendReaction({
    peer,
    msgId: sourceMessageId,
    reaction: [new Api.ReactionEmoji({ emoticon: '❤' })],
  });
}

export async function reactToSentComment(
  client: TelegramClient,
  replyPeer: Api.TypeEntityLike,
  replyMessageId: number,
): Promise<TelegramReactionResult> {
  if (!Number.isSafeInteger(replyMessageId) || replyMessageId < 1) {
    throw new Error('Reply message ID is invalid');
  }
  const entity = await client.getEntity(replyPeer);
  if (!(entity instanceof Api.Channel)) {
    return { status: 'skipped', reason: 'reply_peer_not_channel' };
  }
  const fullChannel = await client.invoke(new Api.channels.GetFullChannel({ channel: entity }));
  const capability = evaluateHeartReactionCapability(fullChannel.fullChat.availableReactions);
  if (!capability.supported) {
    return {
      status: 'skipped',
      reason: capability.reason ?? 'heart_reaction_unavailable',
    };
  }
  const peer = await client.getInputEntity(replyPeer);
  await client.invoke(createHeartReactionRequest(peer, replyMessageId));
  return { status: 'sent' };
}

export async function mapGramJsEvent(
  event: NewMessageEvent,
  subscribedEntity: Api.Channel,
): Promise<TelegramIncomingMessage> {
  const message = event.message;
  const sameChannel = message.peerId instanceof Api.PeerChannel &&
    message.peerId.channelId.equals(subscribedEntity.id);
  let chatKind: TelegramIncomingMessage['chatKind'] = 'unknown';

  if (subscribedEntity.megagroup === true) {
    chatKind = message.replyTo instanceof Api.MessageReplyHeader &&
      (message.replyTo.replyToTopId !== undefined || message.replyTo.forumTopic === true)
      ? 'discussion'
      : 'supergroup';
  } else if (
    subscribedEntity.broadcast === true &&
    message.post === true &&
    sameChannel
  ) {
    chatKind = 'channel_post';
  }

  const sender = await message.getSender().catch(() => undefined);
  const resolvedSenderDisplayName = telegramEntityDisplayName(sender);
  const senderDisplayNames = uniqueSenderDisplayNames([
    { source: 'post_author', value: message.postAuthor },
    { source: 'from_id_sender', value: resolvedSenderDisplayName },
    { source: 'channel_title_fallback', value: subscribedEntity.title },
  ]);
  const senderDisplayName = senderDisplayNames[0]?.value;

  return {
    chatKind,
    sourceMessageId: message.id,
    text: message.text ?? '',
    ...(senderDisplayName === undefined ? {} : { senderDisplayName }),
    ...(senderDisplayNames.length === 0 ? {} : { senderDisplayNames }),
    ...(sameChannel ? { telegramChannelId: subscribedEntity.id.toString() } : {}),
  };
}

function telegramChannelIdFromEvent(event: NewMessageEvent): string | undefined {
  const peer = event.message.peerId;
  return peer instanceof Api.PeerChannel ? peer.channelId.toString() : undefined;
}

function diagnosticFields(
  context: TelegramChannelSubscriptionContext,
  nativeClientInstanceId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    assignmentId: context.assignmentId,
    accountId: context.accountId,
    accountSessionKey: context.accountSessionKey,
    channelId: context.channelId,
    expectedTelegramChannelId: context.expectedTelegramChannelId,
    nativeClientInstanceId,
    ...extra,
  };
}

function rawUpdateMetadata(
  event: NewMessageEvent,
  entity: Api.Channel,
  correlationId: string,
): Record<string, unknown> {
  const peer = event.message.peerId;
  return {
    correlationId,
    updateType: event.originalUpdate.constructor.name,
    ...(peer === undefined ? {} : { rawPeerType: peer.constructor.name }),
    ...(peer instanceof Api.PeerChannel ? { rawPeerId: peer.channelId.toString() } : {}),
    post: event.message.post === true,
    broadcast: entity.broadcast === true,
    hasMessage: event.message !== undefined,
  };
}

function scopedChannelReason(
  message: TelegramIncomingMessage,
  expectedTelegramChannelId: string,
): string {
  if (message.chatKind !== 'channel_post') return `chat_kind:${message.chatKind}`;
  if (message.telegramChannelId === undefined) return 'actual_channel_id_unavailable';
  if (message.telegramChannelId !== expectedTelegramChannelId) return 'channel_identity_mismatch';
  return 'unknown_scoped_channel_guard_failure';
}

async function buildTelegramMessageLink(message: Api.Message): Promise<string> {
  const chat = await message.getChat().catch(() => undefined);
  if (chat instanceof Api.Channel && chat.username !== undefined) {
    return createTelegramMessageLink({ username: chat.username, messageId: message.id });
  }
  if (message.peerId instanceof Api.PeerChannel) {
    return createTelegramMessageLink({
      privateChannelId: message.peerId.channelId.toString(),
      messageId: message.id,
    });
  }
  throw new Error('Telegram did not return a linkable reply/comment message');
}

export function createTelegramMessageLink(input: {
  readonly username?: string;
  readonly privateChannelId?: string;
  readonly messageId: number;
}): string {
  if (!Number.isSafeInteger(input.messageId) || input.messageId < 1) {
    throw new Error('Reply message ID is invalid');
  }
  const username = input.username?.replace(/^@/, '');
  if (username !== undefined && /^[A-Za-z0-9_]{5,}$/.test(username)) {
    return `https://t.me/${username}/${input.messageId}`;
  }
  if (input.privateChannelId !== undefined && /^\d+$/.test(input.privateChannelId)) {
    return `https://t.me/c/${input.privateChannelId}/${input.messageId}`;
  }
  throw new Error('Telegram reply/comment does not have a linkable channel identity');
}

export function createTelegramNotificationPayload(notification: TelegramOperationalNotification): {
  readonly message: string;
  readonly formattingEntities?: Api.TypeMessageEntity[];
  readonly linkPreview: false;
} {
  if (notification.link === undefined) {
    return { message: notification.text, linkPreview: false };
  }
  const separator = notification.text.length === 0 ? '' : '\n\n';
  const message = `${notification.text}${separator}${notification.link.label}`;
  return {
    message,
    formattingEntities: [new Api.MessageEntityTextUrl({
      offset: notification.text.length + separator.length,
      length: notification.link.label.length,
      url: notification.link.url,
    })],
    linkPreview: false,
  };
}

function telegramEntityDisplayName(entity: Awaited<ReturnType<Api.Message['getSender']>>): string | undefined {
  if (entity instanceof Api.User) {
    return [entity.firstName, entity.lastName].filter(Boolean).join(' ') || entity.username;
  }
  if (entity instanceof Api.Channel || entity instanceof Api.Chat) return entity.title;
  return undefined;
}

function uniqueSenderDisplayNames(
  candidates: ReadonlyArray<{ readonly source: TelegramSenderDisplayName['source']; readonly value: string | undefined }>,
): TelegramSenderDisplayName[] {
  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    const value = candidate.value?.trim();
    if (value === undefined || value.length === 0) return [];
    const key = value.normalize('NFKC').toLocaleLowerCase('id-ID');
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ source: candidate.source, value }];
  });
}

function normalizeReactionEmoji(emoji: string): string {
  return emoji.replaceAll('\uFE0F', '');
}
