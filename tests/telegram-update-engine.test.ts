import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { Api, type TelegramClient } from 'telegram';
import bigInt from 'big-integer';

import { createLogger } from '../src/logging/logger.js';
import { TelegramChannelSyncStateStore } from '../src/user-client/telegram-channel-sync-state.store.js';
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
      const store = new TelegramChannelSyncStateStore(path.join(root, `account-${accountId}`));
      const liveHandlers: Array<(update: unknown) => void> = [];
      const entities = new Map(channels.map(([id, title]) => [id, createChannel(id, title)]));
      const invoke = vi.fn().mockImplementation((request: unknown) => {
        if (request instanceof Api.updates.GetChannelDifference) {
          return Promise.resolve(new Api.updates.ChannelDifferenceEmpty({ pts: request.pts + 1 }));
        }
        throw new Error(`Unexpected invoke request ${String(request)}`);
      });
      const client = {
        connected: true,
        getEntity(identifier: string) {
          const normalized = identifier.replace(/^@/, '');
          const byTitle = [...entities.values()].find((entity) => entity.title === normalized);
          return Promise.resolve(byTitle ?? entities.get(identifier as (typeof channels)[number][0]) ?? entities.get(normalized as (typeof channels)[number][0]));
        },
        addEventHandler(callback: (update: unknown) => void) {
          liveHandlers.push(callback);
        },
        invoke,
      } as unknown as TelegramClient;
      const engine = new TelegramUpdateEngine(`account-${accountId}`, client, store, logger.logger);
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
          await Promise.resolve();
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
    const store = new TelegramChannelSyncStateStore(path.join(root, 'account-1'));
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

    const first = new TelegramUpdateEngine('account-1', client, store, logger.logger);
    await first.subscribe({
      assignmentId: 1,
      accountId: 1,
      accountKey: 'account-1',
      channel: { id: 1, telegramChannelId: '7000000001', title: 'tes2autobot', enabled: true, status: 'active', createdAt: '', updatedAt: '' },
      identifier: '7000000001',
      onLivePost: () => Promise.resolve(),
      onError: () => Promise.resolve(),
    });
    expect(store.get(1, 1)?.pts).toBe(55);

    const secondHandlers: Array<(update: unknown) => void> = [];
    const secondClient = {
      connected: true,
      getEntity: () => Promise.resolve(entity),
      addEventHandler(callback: (update: unknown) => void) {
        secondHandlers.push(callback);
      },
      invoke,
    } as unknown as TelegramClient;
    const second = new TelegramUpdateEngine('account-1', secondClient, store, logger.logger);
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
    expect(store.get(1, 1)?.pts).toBe(56);
    logger.close();
  });

  it('recovers channel gap without emitting recovered history and emits the next live post', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-engine-gap-'));
    const logger = createLogger({ level: 'error', logDirectory: path.join(root, 'logs'), environment: 'test', writeToStdout: false });
    const store = new TelegramChannelSyncStateStore(path.join(root, 'account-1'));
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
    const engine = new TelegramUpdateEngine('account-1', client, store, logger.logger);
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
});
