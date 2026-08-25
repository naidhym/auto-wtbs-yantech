import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it, vi } from 'vitest';
import { Api, type TelegramClient } from 'telegram';
import bigInt from 'big-integer';

import { createLogger } from '../src/logging/logger.js';
import { configureSqliteConnection } from '../src/database/database.service.js';
import { foundationMigration } from '../src/database/migrations/0001-foundation.js';
import { accountSessionMigration } from '../src/database/migrations/0002-account-session.js';
import { independentChannelsMigration } from '../src/database/migrations/0003-independent-channels.js';
import { rulesAndTemplatesMigration } from '../src/database/migrations/0004-rules-and-templates.js';
import { accountReplyTemplatesMigration } from '../src/database/migrations/0005-account-reply-templates.js';
import { autoReplySafetyMigration } from '../src/database/migrations/0006-auto-reply-safety.js';
import { perAccountDispatchDeduplicationMigration } from '../src/database/migrations/0007-per-account-dispatch-deduplication.js';
import { accountNotificationTargetMigration } from '../src/database/migrations/0008-account-notification-target.js';
import { telegramChannelSyncStateMigration } from '../src/database/migrations/0009-telegram-channel-sync-state.js';
import { TelegramChannelSyncStateRepository } from '../src/user-client/telegram-channel-sync-state.repository.js';
import { TelegramUpdateEngine } from '../src/user-client/telegram-update.engine.js';

function createChannel(id: string, title: string): Api.Channel {
  return new Api.Channel({
    id: bigInt(id),
    accessHash: bigInt(`9${id}`),
    title,
    photo: new Api.ChatPhotoEmpty(),
    date: 0,
    broadcast: true,
  });
}

function createMessage(channelId: string, id: number, text = 'hello'): Api.Message {
  return new Api.Message({
    out: false,
    mentioned: false,
    mediaUnread: false,
    silent: false,
    post: true,
    id,
    peerId: new Api.PeerChannel({ channelId: bigInt(channelId) }),
    message: text,
    date: 0,
  });
}

function createSyncRepository(root: string, channels: ReadonlyArray<readonly [string, string]>): TelegramChannelSyncStateRepository {
  fs.mkdirSync(root, { recursive: true });
  const databasePath = path.join(root, 'sync.sqlite');
  const database = new DatabaseSync(databasePath);
  configureSqliteConnection(database);
  foundationMigration.up(database);
  accountSessionMigration.up(database);
  independentChannelsMigration.up(database);
  rulesAndTemplatesMigration.up(database);
  accountReplyTemplatesMigration.up(database);
  autoReplySafetyMigration.up(database);
  perAccountDispatchDeduplicationMigration.up(database);
  accountNotificationTargetMigration.up(database);
  telegramChannelSyncStateMigration.up(database);
  database.exec(`
    INSERT INTO owners (id, telegram_user_id) VALUES (1, 'owner');
    INSERT INTO accounts (id, owner_id, label, session_key, phone_number, is_enabled) VALUES
      (1, 1, 'Shark', 'account-00000000-0000-4000-8000-000000000001', '+62111111111', 1),
      (2, 1, 'Draco', 'account-00000000-0000-4000-8000-000000000002', '+62222222222', 1);
  `);
  const insertChannel = database.prepare(`
    INSERT INTO channels (id, telegram_channel_id, title, is_enabled, status)
    VALUES (?, ?, ?, 1, 'active')
  `);
  for (const [index, [telegramChannelId, title]] of channels.entries()) {
    insertChannel.run(index + 1, telegramChannelId, title);
  }
  return new TelegramChannelSyncStateRepository(database);
}

async function flushEngine(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createClient(
  entities: Map<string, Api.Channel>,
  invoke: (request: unknown) => Promise<unknown>,
  handlers: Array<(update: unknown) => void>,
): TelegramClient {
  return {
    connected: true,
    getEntity(identifier: string) {
      const normalized = identifier.replace(/^@/, '');
      const byTitle = [...entities.values()].find((entity) => entity.title === normalized);
      return Promise.resolve(byTitle ?? entities.get(identifier) ?? entities.get(normalized));
    },
    addEventHandler(callback: (update: unknown) => void) {
      handlers.push(callback);
    },
    invoke,
  } as unknown as TelegramClient;
}

describe('telegram update engine', () => {
  it('subscribes 7 channels x 2 accounts independently and delivers live posts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-engine-'));
    const logger = createLogger({ level: 'error', logDirectory: path.join(root, 'logs'), environment: 'test', writeToStdout: false });
    const channels = [
      ['3980589729', 'tes'],
      ['5000000001', 'BASE WIB'],
      ['5000000002', 'Berdagang Online. (WTB)'],
      ['5000000003', 'BASE WTB BUKALAPAK BA'],
      ['5000000004', 'SWALAYAN'],
      ['5000000005', 'BASE WTB'],
      ['5000000006', 'MONEYFESS: HIRING, OPEN'],
      ['5000000007', 'tes2autobot'],
    ] as const;

    for (const accountId of [1, 2]) {
      const repository = createSyncRepository(path.join(root, `account-${accountId}`), channels);
      const liveHandlers: Array<(update: unknown) => void> = [];
      const entities = new Map(channels.map(([id, title]) => [id, createChannel(id, title)]));
      const invoke = vi.fn().mockImplementation((request: unknown) => {
        if (request instanceof Api.updates.GetChannelDifference) {
          return Promise.resolve(new Api.updates.ChannelDifferenceEmpty({ pts: request.pts + 1 }));
        }
        throw new Error(`Unexpected invoke request ${String(request)}`);
      });
      const client = createClient(entities, invoke, liveHandlers);
      const engine = new TelegramUpdateEngine(`account-${accountId}`, client, repository, logger.logger);
      const received: string[] = [];

      for (const [index, [id, title]] of channels.entries()) {
        await engine.subscribe({
          assignmentId: accountId * 100 + index,
          accountId,
          accountKey: `account-${accountId}`,
          channel: {
            id: index + 1,
            telegramChannelId: id,
            title,
            enabled: true,
            status: 'active',
            createdAt: '',
            updatedAt: '',
          },
          identifier: id,
          onLivePost: (event) => {
            received.push(`${accountId}:${event.telegramChannelId}:${event.sourceMessageId}`);
            return Promise.resolve();
          },
          onError: () => Promise.resolve(),
        });
      }

      for (const [id] of channels) {
        const message = createMessage(id, 1, `post-${id}`);
        await Promise.all(liveHandlers.map(async (handler) => {
          handler(new Api.UpdateNewChannelMessage({ message, pts: 10, ptsCount: 1 }));
          await flushEngine();
        }));
      }

      expect(received).toHaveLength(channels.length);
      expect(engine.getStatus()).toMatchObject({ syncedChannels: channels.length, degradedChannels: 0 });
    }

    logger.close();
  });

  it('restores persisted sync state after restart and resumes live delivery', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-engine-restart-'));
    const logger = createLogger({ level: 'error', logDirectory: path.join(root, 'logs'), environment: 'test', writeToStdout: false });
    const repository = createSyncRepository(root, [['7000000001', 'tes2autobot']]);
    const entity = createChannel('7000000001', 'tes2autobot');
    const invoke = vi.fn().mockResolvedValue(new Api.updates.ChannelDifferenceEmpty({ pts: 55 }));
    const handlers: Array<(update: unknown) => void> = [];
    const client = {
      connected: true,
      getEntity: () => Promise.resolve(entity),
      addEventHandler(callback: (update: unknown) => void) {
        handlers.push(callback);
      },
      invoke,
    } as unknown as TelegramClient;

    const first = new TelegramUpdateEngine('account-1', client, repository, logger.logger);
    await first.subscribe({
      assignmentId: 1,
      accountId: 1,
      accountKey: 'account-1',
      channel: { id: 1, telegramChannelId: '7000000001', title: 'tes2autobot', enabled: true, status: 'active', createdAt: '', updatedAt: '' },
      identifier: '7000000001',
      onLivePost: () => Promise.resolve(),
      onError: () => Promise.resolve(),
    });
    expect(repository.get(1, 1)?.pts).toBe(55);

    const secondHandlers: Array<(update: unknown) => void> = [];
    const secondClient = {
      connected: true,
      getEntity: () => Promise.resolve(entity),
      addEventHandler(callback: (update: unknown) => void) {
        secondHandlers.push(callback);
      },
      invoke,
    } as unknown as TelegramClient;
    const second = new TelegramUpdateEngine('account-1', secondClient, repository, logger.logger);
    const received: number[] = [];
    await second.subscribe({
      assignmentId: 2,
      accountId: 1,
      accountKey: 'account-1',
      channel: { id: 1, telegramChannelId: '7000000001', title: 'tes2autobot', enabled: true, status: 'active', createdAt: '', updatedAt: '' },
      identifier: '7000000001',
      onLivePost: (event) => {
        received.push(event.sourceMessageId ?? 0);
        return Promise.resolve();
      },
      onError: () => Promise.resolve(),
    });
    await Promise.all(secondHandlers.map(async (handler) => {
      handler(new Api.UpdateNewChannelMessage({ message: createMessage('7000000001', 99, 'fresh'), pts: 56, ptsCount: 1 }));
      await Promise.resolve();
    }));
    expect(received).toEqual([99]);
    expect(repository.get(1, 1)?.pts).toBe(56);
    logger.close();
  });

  it('recovers channel gap without emitting recovered history and emits the next live post', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-engine-gap-'));
    const logger = createLogger({ level: 'error', logDirectory: path.join(root, 'logs'), environment: 'test', writeToStdout: false });
    const repository = createSyncRepository(root, [['7000000002', 'BASE WIB']]);
    const entity = createChannel('7000000002', 'BASE WIB');
    const invoke = vi.fn()
      .mockResolvedValueOnce(new Api.updates.ChannelDifference({
        final: false,
        pts: 11,
        timeout: 0,
        newMessages: [createMessage('7000000002', 1, 'old-1')],
        otherUpdates: [],
        chats: [],
        users: [],
      }))
      .mockResolvedValueOnce(new Api.updates.ChannelDifferenceEmpty({ pts: 12 }));
    const handlers: Array<(update: unknown) => void> = [];
    const client = {
      connected: true,
      getEntity: () => Promise.resolve(entity),
      addEventHandler(callback: (update: unknown) => void) {
        handlers.push(callback);
      },
      invoke,
    } as unknown as TelegramClient;
    const engine = new TelegramUpdateEngine('account-1', client, repository, logger.logger);
    const live: number[] = [];
    await engine.subscribe({
      assignmentId: 1,
      accountId: 1,
      accountKey: 'account-1',
      channel: { id: 1, telegramChannelId: '7000000002', title: 'BASE WIB', enabled: true, status: 'active', createdAt: '', updatedAt: '' },
      identifier: '7000000002',
      onLivePost: (event) => {
        live.push(event.sourceMessageId ?? 0);
        return Promise.resolve();
      },
      onError: () => Promise.resolve(),
    });
    expect(live).toEqual([]);
    await Promise.all(handlers.map(async (handler) => {
      handler(new Api.UpdateNewChannelMessage({ message: createMessage('7000000002', 2, 'fresh'), pts: 13, ptsCount: 1 }));
      await Promise.resolve();
    }));
    expect(live).toEqual([2]);
    logger.close();
  });

  it('resynchronizes all subscribed channels on reconnect and keeps live delivery working', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-engine-reconnect-'));
    const logger = createLogger({ level: 'error', logDirectory: path.join(root, 'logs'), environment: 'test', writeToStdout: false });
    const channels = [['7000000101', 'tes'], ['7000000102', 'tes2autobot']] as const;
    const repository = createSyncRepository(root, channels);
    const handlers: Array<(update: unknown) => void> = [];
    const entities = new Map(channels.map(([id, title]) => [id, createChannel(id, title)]));
    const invoke = vi.fn().mockImplementation((request: unknown) => {
      if (request instanceof Api.updates.GetChannelDifference) {
        return Promise.resolve(new Api.updates.ChannelDifferenceEmpty({ pts: request.pts + 10 }));
      }
      throw new Error('unexpected request');
    });
    const engine = new TelegramUpdateEngine('account-1', createClient(entities, invoke, handlers), repository, logger.logger);
    const received: number[] = [];

    for (const [index, [id, title]] of channels.entries()) {
      await engine.subscribe({
        assignmentId: index + 1,
        accountId: 1,
        accountKey: 'account-1',
        channel: { id: index + 1, telegramChannelId: id, title, enabled: true, status: 'active', createdAt: '', updatedAt: '' },
        identifier: id,
        onLivePost: (event) => {
          received.push(event.sourceMessageId ?? 0);
          return Promise.resolve();
        },
        onError: () => Promise.resolve(),
      });
    }

    const invokeCountBefore = invoke.mock.calls.length;
    await engine.resynchronizeAll('reconnect');
    expect(invoke.mock.calls.length).toBeGreaterThan(invokeCountBefore);
    expect(engine.getStatus().syncedChannels).toBe(2);

    handlers[0]?.(new Api.UpdateNewChannelMessage({ message: createMessage('7000000101', 77, 'live'), pts: 99, ptsCount: 1 }));
    await flushEngine();
    expect(received).toContain(77);
    logger.close();
  });

  it('handles ChannelDifferenceTooLong by advancing pts and becoming healthy', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-engine-toolong-'));
    const logger = createLogger({ level: 'error', logDirectory: path.join(root, 'logs'), environment: 'test', writeToStdout: false });
    const repository = createSyncRepository(root, [['7000000201', 'BASE WTB']]);
    const entity = createChannel('7000000201', 'BASE WTB');
    const handlers: Array<(update: unknown) => void> = [];
    const invoke = vi.fn().mockResolvedValue(new Api.updates.ChannelDifferenceTooLong({
      dialog: new Api.Dialog({
        pinned: false,
        unreadMark: false,
        peer: new Api.PeerChannel({ channelId: bigInt('7000000201') }),
        topMessage: 0,
        readInboxMaxId: 0,
        readOutboxMaxId: 0,
        unreadCount: 0,
        unreadMentionsCount: 0,
        unreadReactionsCount: 0,
        notifySettings: new Api.PeerNotifySettings({}),
        pts: 321,
      }),
      messages: [],
      chats: [],
      users: [],
    }));
    const engine = new TelegramUpdateEngine('account-1', {
      connected: true,
      getEntity: () => Promise.resolve(entity),
      addEventHandler(callback: (update: unknown) => void) {
        handlers.push(callback);
      },
      invoke,
    } as unknown as TelegramClient, repository, logger.logger);

    await engine.subscribe({
      assignmentId: 1,
      accountId: 1,
      accountKey: 'account-1',
      channel: { id: 1, telegramChannelId: '7000000201', title: 'BASE WTB', enabled: true, status: 'active', createdAt: '', updatedAt: '' },
      identifier: '7000000201',
      onLivePost: () => Promise.resolve(),
      onError: () => Promise.resolve(),
    });

    expect(repository.get(1, 1)).toMatchObject({ pts: 321, syncStatus: 'healthy' });
    expect(engine.getStatus().channels[0]).toMatchObject({ health: 'HEALTHY', pts: 321 });
    logger.close();
  });

  it('isolates one channel sync failure without stopping another healthy channel', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-engine-channel-isolation-'));
    const logger = createLogger({ level: 'error', logDirectory: path.join(root, 'logs'), environment: 'test', writeToStdout: false });
    const channels = [['7000000301', 'bad'], ['7000000302', 'good']] as const;
    const repository = createSyncRepository(root, channels);
    const handlers: Array<(update: unknown) => void> = [];
    const entities = new Map(channels.map(([id, title]) => [id, createChannel(id, title)]));
    const invoke = vi.fn().mockImplementation((request: unknown) => {
      if (!(request instanceof Api.updates.GetChannelDifference)) throw new Error('unexpected');
      const inputChannel = request.channel as Api.InputChannel;
      if (inputChannel.channelId.toString() === '7000000301') {
        return Promise.reject(new Error('CHANNEL_SYNC_FAIL'));
      }
      return Promise.resolve(new Api.updates.ChannelDifferenceEmpty({ pts: request.pts + 1 }));
    });
    const engine = new TelegramUpdateEngine('account-1', createClient(entities, invoke, handlers), repository, logger.logger);
    const badErrors: string[] = [];
    const goodLive: number[] = [];

    await expect(engine.subscribe({
      assignmentId: 1,
      accountId: 1,
      accountKey: 'account-1',
      channel: { id: 1, telegramChannelId: '7000000301', title: 'bad', enabled: true, status: 'active', createdAt: '', updatedAt: '' },
      identifier: '7000000301',
      onLivePost: () => Promise.resolve(),
      onError: (error) => {
        badErrors.push(String(error));
        return Promise.resolve();
      },
    })).resolves.toBeTypeOf('function');

    await engine.subscribe({
      assignmentId: 2,
      accountId: 1,
      accountKey: 'account-1',
      channel: { id: 2, telegramChannelId: '7000000302', title: 'good', enabled: true, status: 'active', createdAt: '', updatedAt: '' },
      identifier: '7000000302',
      onLivePost: (event) => {
        goodLive.push(event.sourceMessageId ?? 0);
        return Promise.resolve();
      },
      onError: () => Promise.resolve(),
    });

    handlers[0]?.(new Api.UpdateNewChannelMessage({ message: createMessage('7000000302', 55, 'fresh'), pts: 20, ptsCount: 1 }));
    await flushEngine();

    expect(repository.get(1, 1)?.syncStatus).toBe('error');
    expect(repository.get(1, 2)?.syncStatus).toBe('healthy');
    expect(goodLive).toEqual([55]);
    expect(badErrors[0]).toContain('CHANNEL_SYNC_FAIL');
    logger.close();
  });

  it('keeps one account ingestion failure isolated from another account engine', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-engine-account-isolation-'));
    const logger = createLogger({ level: 'error', logDirectory: path.join(root, 'logs'), environment: 'test', writeToStdout: false });
    const channels = [['7000000401', 'tes']] as const;
    const badRepository = createSyncRepository(path.join(root, 'a1'), channels);
    const goodRepository = createSyncRepository(path.join(root, 'a2'), channels);
    const entity = createChannel('7000000401', 'tes');
    const badHandlers: Array<(update: unknown) => void> = [];
    const goodHandlers: Array<(update: unknown) => void> = [];

    const badEngine = new TelegramUpdateEngine('account-1', {
      connected: true,
      getEntity: () => Promise.resolve(entity),
      addEventHandler(callback: (update: unknown) => void) {
        badHandlers.push(callback);
      },
      invoke: () => Promise.reject(new Error('ACCOUNT_ONE_SYNC_FAIL')),
    } as unknown as TelegramClient, badRepository, logger.logger);

    const goodEngine = new TelegramUpdateEngine('account-2', {
      connected: true,
      getEntity: () => Promise.resolve(entity),
      addEventHandler(callback: (update: unknown) => void) {
        goodHandlers.push(callback);
      },
      invoke: (request: unknown) => {
        if (request instanceof Api.updates.GetChannelDifference) {
          return Promise.resolve(new Api.updates.ChannelDifferenceEmpty({ pts: 10 }));
        }
        throw new Error('unexpected');
      },
    } as unknown as TelegramClient, goodRepository, logger.logger);

    await expect(badEngine.subscribe({
      assignmentId: 1,
      accountId: 1,
      accountKey: 'account-1',
      channel: { id: 1, telegramChannelId: '7000000401', title: 'tes', enabled: true, status: 'active', createdAt: '', updatedAt: '' },
      identifier: '7000000401',
      onLivePost: () => Promise.resolve(),
      onError: () => Promise.resolve(),
    })).resolves.toBeTypeOf('function');

    const goodLive: number[] = [];
    await goodEngine.subscribe({
      assignmentId: 2,
      accountId: 2,
      accountKey: 'account-2',
      channel: { id: 1, telegramChannelId: '7000000401', title: 'tes', enabled: true, status: 'active', createdAt: '', updatedAt: '' },
      identifier: '7000000401',
      onLivePost: (event) => {
        goodLive.push(event.sourceMessageId ?? 0);
        return Promise.resolve();
      },
      onError: () => Promise.resolve(),
    });

    goodHandlers[0]?.(new Api.UpdateNewChannelMessage({ message: createMessage('7000000401', 88, 'fresh'), pts: 11, ptsCount: 1 }));
    await flushEngine();
    expect(badRepository.get(1, 1)?.syncStatus).toBe('error');
    expect(goodLive).toEqual([88]);
    expect(goodRepository.get(2, 1)?.syncStatus).toBe('healthy');
    logger.close();
  });

  it('recovers safely from stale persisted state by resynchronizing before emitting live events', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-engine-stale-state-'));
    const logger = createLogger({ level: 'error', logDirectory: path.join(root, 'logs'), environment: 'test', writeToStdout: false });
    const repository = createSyncRepository(root, [['7000000501', 'stale']]);
    repository.reset(1, 1);
    const entity = createChannel('7000000501', 'stale');
    const handlers: Array<(update: unknown) => void> = [];
    const invoke = vi.fn().mockResolvedValue(new Api.updates.ChannelDifferenceEmpty({ pts: 40 }));
    const engine = new TelegramUpdateEngine('account-1', {
      connected: true,
      getEntity: () => Promise.resolve(entity),
      addEventHandler(callback: (update: unknown) => void) {
        handlers.push(callback);
      },
      invoke,
    } as unknown as TelegramClient, repository, logger.logger);
    const live: number[] = [];

    await engine.subscribe({
      assignmentId: 1,
      accountId: 1,
      accountKey: 'account-1',
      channel: { id: 1, telegramChannelId: '7000000501', title: 'stale', enabled: true, status: 'active', createdAt: '', updatedAt: '' },
      identifier: '7000000501',
      onLivePost: (event) => {
        live.push(event.sourceMessageId ?? 0);
        return Promise.resolve();
      },
      onError: () => Promise.resolve(),
    });

    expect(repository.get(1, 1)).toMatchObject({ pts: 40, syncStatus: 'healthy' });
    handlers[0]?.(new Api.UpdateNewChannelMessage({ message: createMessage('7000000501', 41, 'fresh'), pts: 41, ptsCount: 1 }));
    await flushEngine();
    expect(live).toEqual([41]);
    logger.close();
  });

  it('synchronizes a channel added after startup and marks it healthy before live delivery', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-engine-add-channel-'));
    const logger = createLogger({ level: 'error', logDirectory: path.join(root, 'logs'), environment: 'test', writeToStdout: false });
    const repository = createSyncRepository(root, [['7000000601', 'tes'], ['7000000602', 'new-channel']]);
    const handlers: Array<(update: unknown) => void> = [];
    const entities = new Map([
      ['7000000601', createChannel('7000000601', 'tes')],
      ['7000000602', createChannel('7000000602', 'new-channel')],
    ]);
    const invoke = vi.fn().mockImplementation((request: unknown) => {
      if (request instanceof Api.updates.GetChannelDifference) {
        return Promise.resolve(new Api.updates.ChannelDifferenceEmpty({ pts: request.pts + 1 }));
      }
      throw new Error('unexpected');
    });
    const engine = new TelegramUpdateEngine('account-1', createClient(entities, invoke, handlers), repository, logger.logger);

    await engine.subscribe({
      assignmentId: 1,
      accountId: 1,
      accountKey: 'account-1',
      channel: { id: 1, telegramChannelId: '7000000601', title: 'tes', enabled: true, status: 'active', createdAt: '', updatedAt: '' },
      identifier: '7000000601',
      onLivePost: () => Promise.resolve(),
      onError: () => Promise.resolve(),
    });

    const live: number[] = [];
    await engine.subscribe({
      assignmentId: 2,
      accountId: 1,
      accountKey: 'account-1',
      channel: { id: 2, telegramChannelId: '7000000602', title: 'new-channel', enabled: true, status: 'active', createdAt: '', updatedAt: '' },
      identifier: '7000000602',
      onLivePost: (event) => {
        live.push(event.sourceMessageId ?? 0);
        return Promise.resolve();
      },
      onError: () => Promise.resolve(),
    });

    expect(repository.get(1, 2)?.syncStatus).toBe('healthy');
    expect(engine.getStatus().channels.find((channel) => channel.channelId === 2)?.health).toBe('HEALTHY');

    handlers[0]?.(new Api.UpdateNewChannelMessage({ message: createMessage('7000000602', 12, 'fresh'), pts: 12, ptsCount: 1 }));
    await flushEngine();
    expect(live).toEqual([12]);
    logger.close();
  });
});
