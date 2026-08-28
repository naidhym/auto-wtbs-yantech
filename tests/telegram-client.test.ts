import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { Api, type TelegramClient } from 'telegram';
import bigInt from 'big-integer';
import type { UserAuthParams } from 'telegram/client/auth.js';
import { NewMessageEvent } from 'telegram/events/index.js';
import type { TelegramEngineStatus } from '../src/user-client/telegram-update.engine.js';

import { createLogger } from '../src/logging/logger.js';
import { DatabaseService } from '../src/database/database.service.js';
import { TelegramChannelSyncStateRepository } from '../src/user-client/telegram-channel-sync-state.repository.js';
import {
  createHeartReactionRequest,
  createEmojiReactionRequest,
  createTelegramNotificationPayload,
  createTelegramMessageLink,
  createChannelMessageBuilder,
  evaluateHeartReactionCapability,
  evaluateReactionCapability,
  GramJsClientService,
  mapGramJsEvent,
  reactToChannelMessage,
  resolveBroadcastChannel,
  type TelegramClientAdapter,
} from '../src/user-client/gramjs-client.service.js';

class FakeTelegramClient implements TelegramClientAdapter {
  public connected: boolean | undefined = false;

  public resolveChannel(identifier: string) {
    return Promise.resolve({ telegramChannelId: identifier, title: identifier });
  }

  public subscribeChannel() {
    return Promise.resolve(() => Promise.resolve());
  }
  public getEngineStatus(): TelegramEngineStatus {
    return {
      accountKey: 'fake-account',
      connected: this.connected === true,
      channels: [],
      syncedChannels: 0,
      degradedChannels: 0,
    };
  }
  public resynchronizeAll(): Promise<void> {
    return Promise.resolve();
  }
  public markAllDisconnected(): void {
    this.connected = false;
  }
  public sendChannelComment() {
    return Promise.resolve({
      messageId: 1,
      resolveMessageLink: () => Promise.resolve('https://t.me/c/1/1'),
    });
  }
  public reactToChannelMessage() {
    return Promise.resolve({ status: 'sent' as const });
  }
  public sendOperationalNotification() {
    return Promise.resolve();
  }
  public connectCalls = 0;
  public disconnectCalls = 0;
  public destroyCalls = 0;

  public connect(): Promise<boolean> {
    this.connectCalls += 1;
    this.connected = true;
    return Promise.resolve(true);
  }

  public disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    this.connected = false;
    return Promise.resolve();
  }

  public destroy(): Promise<void> {
    this.destroyCalls += 1;
    this.connected = false;
    return Promise.resolve();
  }

  public start(_authParams: UserAuthParams): Promise<void> {
    void _authParams;
    this.connected = true;
    return Promise.resolve();
  }

  public checkAuthorization(): Promise<boolean> {
    return Promise.resolve(true);
  }

  public saveSession(): string {
    return 'test-session';
  }

  public getTelegramUserId(): Promise<string> {
    return Promise.resolve('123456');
  }
}

describe('GramJS client lifecycle foundation', () => {

  it('builds a pre-resolvable numeric channel filter and normalizes only broadcast posts', async () => {
    const builder = createChannelMessageBuilder('123456789');
    expect(builder.chats).toEqual(['123456789']);
    await expect(builder.resolve({} as TelegramClient)).resolves.toBeUndefined();
    expect(builder.resolved).toBe(true);

    const channel = new Api.Channel({
      id: bigInt('123456789'),
      title: 'Broadcast Test',
      photo: new Api.ChatPhotoEmpty(),
      date: 0,
      broadcast: true,
    });
    const message = new Api.Message({
      out: false,
      mentioned: false,
      mediaUnread: false,
      silent: false,
      post: true,
      id: 77,
      peerId: new Api.PeerChannel({ channelId: bigInt('123456789') }),
      message: 'BUCIN available',
      date: 0,
    });
    const update = new Api.UpdateNewChannelMessage({ message, pts: 1, ptsCount: 1 });
    const mapped = await mapGramJsEvent(new NewMessageEvent(message, update), channel);
    expect(mapped).toMatchObject({
      chatKind: 'channel_post',
      telegramChannelId: '123456789',
      sourceMessageId: 77,
    });

    const mismatched = new Api.Message({
      out: false,
      mentioned: false,
      mediaUnread: false,
      silent: false,
      post: true,
      id: 78,
      peerId: new Api.PeerChannel({ channelId: bigInt('987654321') }),
      message: 'bucin',
      date: 0,
    });
    const mismatchedUpdate = new Api.UpdateNewChannelMessage({
      message: mismatched,
      pts: 2,
      ptsCount: 1,
    });
    await expect(mapGramJsEvent(
      new NewMessageEvent(mismatched, mismatchedUpdate),
      channel,
    )).resolves.toMatchObject({ chatKind: 'unknown' });

    const signedPost = new Api.Message({
      out: false,
      mentioned: false,
      mediaUnread: false,
      silent: false,
      post: true,
      id: 79,
      peerId: new Api.PeerChannel({ channelId: bigInt('123456789') }),
      postAuthor: '‼️ JGN REPLY ‼️',
      message: 'bucin',
      date: 0,
    });
    const signedUpdate = new Api.UpdateNewChannelMessage({ message: signedPost, pts: 3, ptsCount: 1 });
    const signedMapped = await mapGramJsEvent(new NewMessageEvent(signedPost, signedUpdate), channel);
    expect(signedMapped.senderDisplayName).toBe('‼️ JGN REPLY ‼️');
    expect(signedMapped.senderDisplayNames).toContainEqual({
      source: 'post_author',
      value: '‼️ JGN REPLY ‼️',
    });
    expect(signedMapped.senderDisplayNames).toContainEqual({
      source: 'channel_title_fallback',
      value: 'Broadcast Test',
    });
  });

  it('keeps multiple numeric broadcast-channel builders independent on one client', async () => {
    const first = createChannelMessageBuilder('111111111');
    const second = createChannelMessageBuilder('222222222');
    await Promise.all([
      first.resolve({} as TelegramClient),
      second.resolve({} as TelegramClient),
    ]);

    expect(first).not.toBe(second);
    expect(first.chats).toContain('-100111111111');
    expect(second.chats).toContain('-100222222222');

    const firstMessage = new Api.Message({
      out: false,
      mentioned: false,
      mediaUnread: false,
      silent: false,
      post: true,
      id: 1,
      peerId: new Api.PeerChannel({ channelId: bigInt('111111111') }),
      message: '',
      date: 0,
    });
    const secondMessage = new Api.Message({
      out: false,
      mentioned: false,
      mediaUnread: false,
      silent: false,
      post: true,
      id: 2,
      peerId: new Api.PeerChannel({ channelId: bigInt('222222222') }),
      message: '',
      date: 0,
    });
    const firstEvent = new NewMessageEvent(
      firstMessage,
      new Api.UpdateNewChannelMessage({ message: firstMessage, pts: 1, ptsCount: 1 }),
    );
    const secondEvent = new NewMessageEvent(
      secondMessage,
      new Api.UpdateNewChannelMessage({ message: secondMessage, pts: 2, ptsCount: 1 }),
    );

    expect(first.filter(firstEvent)).toBeDefined();
    expect(second.filter(firstEvent)).toBeUndefined();
    expect(first.filter(secondEvent)).toBeUndefined();
    expect(second.filter(secondEvent)).toBeDefined();
  });

  it('hydrates a private numeric channel from dialogs and rejects megagroups', async () => {
    const privateChannel = new Api.Channel({
      id: bigInt('555000111'),
      title: 'Private Broadcast',
      photo: new Api.ChatPhotoEmpty(),
      date: 0,
      broadcast: true,
      left: true,
    });
    const hydratedClient = {
      getEntity: () => Promise.reject(new Error('entity cache miss')),
      async *iterDialogs() {
        await Promise.resolve();
        yield { entity: privateChannel };
      },
    } as unknown as TelegramClient;
    await expect(resolveBroadcastChannel(hydratedClient, '555000111'))
      .resolves.toBe(privateChannel);

    const megagroup = new Api.Channel({
      id: bigInt('555000222'),
      title: 'Supergroup',
      photo: new Api.ChatPhotoEmpty(),
      date: 0,
      megagroup: true,
    });
    const megagroupClient = {
      getEntity: () => Promise.resolve(megagroup),
    } as unknown as TelegramClient;
    await expect(resolveBroadcastChannel(megagroupClient, '@supergroup'))
      .resolves.toBe(megagroup);

    const notChannelClient = {
      getEntity: () => Promise.resolve({}),
    } as unknown as TelegramClient;
    await expect(resolveBroadcastChannel(notChannelClient, '@thing'))
      .rejects.toThrow(/not a channel/i);
  });

  it('builds direct links to public and private reply/comment messages', () => {
    expect(createTelegramMessageLink({ username: '@market_channel', messageId: 77 }))
      .toBe('https://t.me/market_channel/77');
    expect(createTelegramMessageLink({ privateChannelId: '1234567890', messageId: 88 }))
      .toBe('https://t.me/c/1234567890/88');
    expect(() => createTelegramMessageLink({ messageId: 0 })).toThrow(/invalid/i);
  });

  it('builds a monitoring-bot notification with a source-post link entity', () => {
    const payload = createTelegramNotificationPayload({
      text: '🤖 AUTO WTB\n\nChannel: BASE WIB\nTrigger: bucin',
      link: {
        label: '🔗 Open Source Message',
        url: 'https://t.me/base_wib/77',
      },
    });
    expect(payload.message).toContain('🔗 Open Source Message');
    expect(payload.linkPreview).toBe(false);
    expect(payload.formattingEntities).toEqual([
      expect.objectContaining({
        url: 'https://t.me/base_wib/77',
        length: '🔗 Open Source Message'.length,
      }),
    ]);
  });

  it('evaluates configured reactions and targets the reply message on its exact peer', async () => {
    expect(evaluateHeartReactionCapability(undefined)).toEqual({
      supported: false,
      reason: 'chat_reactions_none',
    });
    expect(evaluateHeartReactionCapability(new Api.ChatReactionsNone())).toEqual({
      supported: false,
      reason: 'chat_reactions_none',
    });
    expect(evaluateHeartReactionCapability(new Api.ChatReactionsAll({}))).toEqual({
      supported: true,
    });
    expect(evaluateHeartReactionCapability(new Api.ChatReactionsSome({
      reactions: [new Api.ReactionEmoji({ emoticon: '👍' })],
    }))).toEqual({ supported: false, reason: 'configured_reaction_unavailable' });
    expect(evaluateHeartReactionCapability(new Api.ChatReactionsSome({
      reactions: [new Api.ReactionEmoji({ emoticon: '❤️' })],
    }))).toEqual({ supported: true });

    const sourcePeer = new Api.InputPeerChannel({
      channelId: bigInt('123456789'),
      accessHash: bigInt('987654321'),
    });
    const request = createHeartReactionRequest(sourcePeer, 77);
    expect(request.peer).toBe(sourcePeer);
    expect(request.msgId).toBe(77);
    expect(request.reaction).toEqual([
      expect.objectContaining({ emoticon: '❤' }),
    ]);

    const replyPeer = new Api.InputPeerChat({ chatId: bigInt('555') });
    const configuredRequest = createEmojiReactionRequest(replyPeer, 200, '👍');
    expect(evaluateReactionCapability(new Api.ChatReactionsSome({
      reactions: [new Api.ReactionEmoji({ emoticon: '👍' })],
    }), '👍')).toEqual({ supported: true });
    expect(configuredRequest.peer).toBe(replyPeer);
    expect(configuredRequest.msgId).toBe(200);
    expect(configuredRequest.msgId).not.toBe(100);
    expect(configuredRequest.reaction).toEqual([
      expect.objectContaining({ emoticon: '👍' }),
    ]);

    const channel = new Api.Channel({
      id: bigInt('123456789'),
      accessHash: bigInt('987654321'),
      title: 'Broadcast Test',
      photo: new Api.ChatPhotoEmpty(),
      date: 0,
      broadcast: true,
    });
    const invoked: unknown[] = [];
    const client = {
      getEntity: () => Promise.resolve(channel),
      getInputEntity: () => Promise.resolve(sourcePeer),
      invoke(requestValue: unknown) {
        invoked.push(requestValue);
        if (requestValue instanceof Api.channels.GetFullChannel) {
          return Promise.resolve({
            fullChat: {
              availableReactions: new Api.ChatReactionsSome({
                reactions: [new Api.ReactionEmoji({ emoticon: '❤' })],
              }),
            },
          });
        }
        return Promise.resolve({});
      },
    } as unknown as TelegramClient;
    await expect(reactToChannelMessage(client, channel, 77)).resolves.toEqual({
      status: 'sent',
    });
    expect(invoked).toHaveLength(2);
    expect(invoked[1]).toMatchObject({ peer: sourcePeer, msgId: 77 });
  });

  it('supports connect, disconnect, reconnect, and status without auth flow', async () => {
    const logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-wtb-client-'));
    const loggerHandle = createLogger({
      level: 'error',
      logDirectory,
      environment: 'test',
      writeToStdout: false,
    });
    const adapter = new FakeTelegramClient();
    const databasePath = path.join(logDirectory, 'test.sqlite');
    const database = new DatabaseService(databasePath, loggerHandle.logger);
    database.initialize();
    database.ensureOwner('owner');
    database.getConnection().prepare(`
      INSERT INTO accounts (owner_id, label, phone_number, session_key, is_enabled)
      VALUES (1, 'Account One', '+62123456789', 'account-1', 1)
    `).run();
    const service = new GramJsClientService(
      {
        accountKey: 'account-1',
        apiId: 12345,
        apiHash: 'test-hash',
        syncStateRepository: new TelegramChannelSyncStateRepository(database.getConnection()),
      },
      loggerHandle.logger,
      () => adapter,
    );

    expect(service.getStatus()).toMatchObject({
      accountKey: 'account-1',
      state: 'disconnected',
      connected: false,
    });

    await service.connect();
    expect(service.getStatus().state).toBe('connected');

    await service.reconnect();
    expect(service.getStatus()).toMatchObject({ state: 'connected', connected: true });
    expect(adapter.connectCalls).toBe(2);
    expect(adapter.disconnectCalls).toBe(1);

    await service.disconnect();
    expect(service.getStatus()).toMatchObject({
      state: 'disconnected',
      connected: false,
    });
    await service.destroy();
    expect(adapter.destroyCalls).toBe(1);
    database.close();
    loggerHandle.close();
  });
});
