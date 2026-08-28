import { Api, TelegramClient } from 'telegram';
import type { UserAuthParams } from 'telegram/client/auth.js';
import { NewMessage, NewMessageEvent } from 'telegram/events/index.js';
import { LogLevel } from 'telegram/extensions/Logger.js';
import { StringSession } from 'telegram/sessions/index.js';

import type {
  ResolvedTelegramChannel,
  TelegramChannelSubscriptionContext,
} from '../channels/channel.types.js';
import type { TelegramIncomingMessage, TelegramSenderDisplayName } from '../rules/rule.types.js';
import { errorReason, type AppLogger } from '../logging/logger.js';
import {
  normalizeTelegramReactionType,
  parseTelegramReactionType,
} from '../shared/telegram-reaction.js';
import { TelegramUpdateEngine, type TelegramEngineStatus } from './telegram-update.engine.js';
import { TelegramChannelSyncStateRepository } from './telegram-channel-sync-state.repository.js';
import { channelIdsMatch } from './telegram-channel-id.js';

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
  getEngineStatus(): TelegramEngineStatus;
  resynchronizeAll(reason?: 'startup' | 'reconnect'): Promise<void>;
  markAllDisconnected(reason?: string): void;
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
  reactToChannelMessage(
    identifier: string,
    replyMessageId: number,
    reactionType?: string,
  ): Promise<TelegramReactionResult>;
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
  readonly syncStateRepository: TelegramChannelSyncStateRepository;
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
  readonly engine: TelegramEngineStatus;
}

export type TelegramClientFactory = (
  options: GramJsClientOptions,
  logger?: AppLogger,
  nativeClientInstanceId?: string,
) => TelegramClientAdapter;

const consoleLoggerShim = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as AppLogger;

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
  const engine = new TelegramUpdateEngine(
    options.accountKey,
    client,
    options.syncStateRepository,
    logger ?? consoleLoggerShim,
  );
  let backgroundErrorHandler: (error: unknown) => Promise<void> = () => Promise.resolve();
  let listenerRegistrationCount = 0;
  const sentReplyMessages = new Map<string, Api.Message>();
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
    getEngineStatus(): TelegramEngineStatus {
      return engine.getStatus();
    },
    async resynchronizeAll(reason: 'startup' | 'reconnect' = 'reconnect'): Promise<void> {
      await engine.resynchronizeAll(reason);
    },
    markAllDisconnected(reason = 'telegram_client_disconnected'): void {
      engine.markAllDisconnected(reason);
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
      const entity = await resolveBroadcastChannel(client, identifier);
      listenerRegistrationCount += 1;
      logger?.info(
        {
          account: context.accountSessionKey,
          channel: context.channelId,
          action: 'diagnostic_listener_registration',
          status: 'registered',
          reason: 'telegram_update_engine_subscription_registered',
          ...diagnosticFields(context, nativeClientInstanceId),
          resolvedTelegramChannelId: entity.id.toString(),
          registrationIndex: listenerRegistrationCount,
          handlerRegistrationCount: listenerRegistrationCount,
        },
        'Telegram listener diagnostic',
      );
      const unsubscribe = await engine.subscribe({
        assignmentId: context.assignmentId,
        accountId: context.accountId,
        accountKey: context.accountSessionKey,
        channel: {
          id: context.channelId,
          telegramChannelId: context.expectedTelegramChannelId,
          ...(context.usernameUsedForResolution === undefined ? {} : { username: context.usernameUsedForResolution }),
          title: entity.title,
          enabled: true,
          status: 'pending',
          createdAt: '',
          updatedAt: '',
        },
        identifier,
        onLivePost: async (event) => onMessage({ ...event, nativeClientInstanceId }),
        onError,
      });
      return async (): Promise<void> => {
        await unsubscribe();
        listenerRegistrationCount -= 1;
      };
    },
    async sendChannelComment(identifier, sourceMessageId, text) {
      const entity = await resolveBroadcastChannel(client, identifier);
      const sent = await client.sendMessage(entity, {
        message: text,
        commentTo: sourceMessageId,
        linkPreview: false,
      });
      rememberSentReplyMessage(sentReplyMessages, identifier, sent);
      return {
        messageId: sent.id,
        resolveMessageLink: () => buildTelegramMessageLink(sent),
      };
    },
    async reactToChannelMessage(identifier, replyMessageId, reactionType = '❤️') {
      const key = replyReactionContextKey(identifier, replyMessageId);
      const sentReply = sentReplyMessages.get(key);
      if (sentReply === undefined) {
        throw new Error('Exact Telegram peer for the sent reply is unavailable');
      }
      sentReplyMessages.delete(key);
      const targetChat = await sentReply.getChat();
      if (!(targetChat instanceof Api.Channel) && !(targetChat instanceof Api.Chat)) {
        throw new Error('Sent reply did not resolve to a reaction-capable Telegram chat');
      }
      return reactToTelegramMessage(client, targetChat, replyMessageId, reactionType);
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

  public reactToChannelMessage(
    identifier: string,
    replyMessageId: number,
    reactionType = '❤️',
  ): Promise<TelegramReactionResult> {
    return this.enqueue(async () => {
      if (!this.getStatus().connected) throw new Error('Telegram client is not connected');
      return this.client.reactToChannelMessage(identifier, replyMessageId, reactionType);
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
      engine: this.client.getEngineStatus(),
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
      await this.client.resynchronizeAll(transitionState === 'connecting' ? 'startup' : 'reconnect');
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
      this.client.markAllDisconnected();
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
  // Try the identifier as supplied, plus the canonical -100 supergroup/channel
  // form, so channels stored/identified by a bare positive numeric ID (common
  // for production channels that have no @username) resolve as reliably as those
  // identified by @username.
  const attempts: string[] = [identifier];
  if (/^\d+$/.test(identifier)) {
    attempts.push(`-100${identifier}`);
  } else if (identifier.startsWith('-100') && /^\d+$/.test(identifier.slice(4))) {
    attempts.push(identifier.slice(4));
  }

  let entity: unknown;
  let lastError: unknown;
  for (const candidate of attempts) {
    try {
      const resolved = await client.getEntity(candidate);
      if (resolved instanceof Api.Channel) {
        entity = resolved;
        break;
      }
      if (lastError === undefined) {
        lastError = new Error(`Resolved Telegram entity is not a channel: ${candidate}`);
      }
    } catch (error) {
      lastError = error;
    }
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
    if (lastError instanceof Error) throw lastError;
    if (lastError !== undefined) throw new Error(errorReason(lastError));
    throw new Error('Resolved Telegram entity is not a channel');
  }
  // Monitor both broadcast channels and supergroups (megagroups). The native
  // update pipeline delivers their posts as UpdateNewChannelMessage, so they
  // must not be rejected at resolution time.
  if (entity.broadcast !== true && entity.megagroup !== true) {
    throw new Error('Resolved Telegram entity is not a monitorable channel');
  }
  return entity;
}

export function createChannelMessageBuilder(telegramChannelId: string): NewMessage {
  if (!/^\d+$/.test(telegramChannelId)) {
    throw new Error('Telegram channel ID must be numeric');
  }
  return new NewMessage({ chats: [telegramChannelId] });
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
  return evaluateReactionCapability(availableReactions, '❤️');
}

export function evaluateReactionCapability(
  availableReactions: Api.TypeChatReactions | undefined,
  reactionType: string,
): { readonly supported: boolean; readonly reason?: string } {
  const normalizedReaction = normalizeTelegramReactionType(reactionType);
  if (
    availableReactions === undefined ||
    availableReactions instanceof Api.ChatReactionsNone
  ) {
    return { supported: false, reason: 'chat_reactions_none' };
  }
  if (availableReactions instanceof Api.ChatReactionsAll) {
    return { supported: true };
  }
  const configuredReactionAvailable = availableReactions.reactions.some((reaction) =>
    reaction instanceof Api.ReactionEmoji &&
      normalizeTelegramReactionType(reaction.emoticon) === normalizedReaction
  );
  return configuredReactionAvailable
    ? { supported: true }
    : { supported: false, reason: 'configured_reaction_unavailable' };
}

export function createHeartReactionRequest(
  peer: Api.TypeEntityLike,
  targetMessageId: number,
): Api.messages.SendReaction {
  return createEmojiReactionRequest(peer, targetMessageId, '❤️');
}

export function createEmojiReactionRequest(
  peer: Api.TypeEntityLike,
  targetMessageId: number,
  reactionType: string,
): Api.messages.SendReaction {
  if (!Number.isSafeInteger(targetMessageId) || targetMessageId < 1) {
    throw new Error('Reaction target message ID is invalid');
  }
  const configuredReaction = parseTelegramReactionType(reactionType);
  return new Api.messages.SendReaction({
    peer,
    msgId: targetMessageId,
    reaction: [new Api.ReactionEmoji({
      emoticon: normalizeTelegramReactionType(configuredReaction),
    })],
  });
}

export async function reactToChannelMessage(
  client: TelegramClient,
  channel: Api.Channel,
  replyMessageId: number,
  reactionType = '❤️',
): Promise<TelegramReactionResult> {
  return reactToTelegramMessage(client, channel, replyMessageId, reactionType);
}

export async function reactToTelegramMessage(
  client: TelegramClient,
  targetChat: Api.Channel | Api.Chat,
  replyMessageId: number,
  reactionType: string,
): Promise<TelegramReactionResult> {
  if (!Number.isSafeInteger(replyMessageId) || replyMessageId < 1) {
    throw new Error('Reply message ID is invalid');
  }
  const configuredReaction = parseTelegramReactionType(reactionType);
  const availableReactions = await resolveAvailableReactions(client, targetChat);
  const capability = evaluateReactionCapability(availableReactions, configuredReaction);
  if (!capability.supported) {
    return {
      status: 'skipped',
      reason: capability.reason ?? 'configured_reaction_unavailable',
    };
  }
  const peer = await client.getInputEntity(targetChat);
  await client.invoke(createEmojiReactionRequest(peer, replyMessageId, configuredReaction));
  return { status: 'sent' };
}

export async function mapGramJsEvent(
  event: NewMessageEvent,
  subscribedEntity: Api.Channel,
): Promise<TelegramIncomingMessage> {
  const message = event.message;
  const sameChannel = message.peerId instanceof Api.PeerChannel &&
    channelIdsMatch(message.peerId.channelId, subscribedEntity.id);
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

  const resolvedText = resolveIncomingMessageText(message);

  return {
    chatKind,
    sourceMessageId: message.id,
    text: resolvedText,
    ...(senderDisplayName === undefined ? {} : { senderDisplayName }),
    ...(senderDisplayNames.length === 0 ? {} : { senderDisplayNames }),
    ...(sameChannel ? { telegramChannelId: subscribedEntity.id.toString() } : {}),
  };
}

function resolveIncomingMessageText(message: Api.Message): string {
  const rendered = message.text;
  if (typeof rendered === 'string' && rendered.length > 0) {
    return rendered;
  }
  const raw = message.rawText;
  if (typeof raw === 'string' && raw.length > 0) {
    return raw;
  }
  return message.message ?? '';
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

async function resolveAvailableReactions(
  client: TelegramClient,
  targetChat: Api.Channel | Api.Chat,
): Promise<Api.TypeChatReactions | undefined> {
  if (targetChat instanceof Api.Channel) {
    const fullChannel = await client.invoke(
      new Api.channels.GetFullChannel({ channel: targetChat }),
    );
    return fullChannel.fullChat.availableReactions;
  }
  const fullChat = await client.invoke(
    new Api.messages.GetFullChat({ chatId: targetChat.id }),
  );
  return fullChat.fullChat.availableReactions;
}

function replyReactionContextKey(identifier: string, replyMessageId: number): string {
  return `${identifier}\u0000${replyMessageId}`;
}

function rememberSentReplyMessage(
  cache: Map<string, Api.Message>,
  identifier: string,
  message: Api.Message,
): void {
  cache.set(replyReactionContextKey(identifier, message.id), message);
  if (cache.size > 10_000) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
}
