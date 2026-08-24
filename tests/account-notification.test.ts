import { describe, expect, it } from 'vitest';

import type { AccountService } from '../src/accounts/account.service.js';
import { GramJsAccountNotificationGateway } from '../src/automation/gramjs-auto-reply.gateway.js';
import type { TelegramClientRegistry } from '../src/user-client/telegram-client.registry.js';

describe('M6 account notification gateway', () => {
  it('sends a successful action report to the acting userbot Saved Messages with a source link', async () => {
    const sentByAccount = new Map<string, Array<{ target: string; notification: unknown }>>();
    const actionAccountKey = 'account-00000000-0000-4000-8000-000000000a01';
    const otherAccountKey = 'account-00000000-0000-4000-8000-000000000b02';
    const clients = new Map([
      [actionAccountKey, createConnectedNotificationClient(actionAccountKey, sentByAccount)],
      [otherAccountKey, createConnectedNotificationClient(otherAccountKey, sentByAccount)],
    ]);
    const accounts = {
      get: (accountKey: string) => ({ enabled: clients.has(accountKey), nickname: accountKey }),
    } as unknown as AccountService;
    const registry = { get: (accountKey: string) => clients.get(accountKey) } as unknown as TelegramClientRegistry;
    const gateway = new GramJsAccountNotificationGateway(accounts, registry);

    await expect(gateway.notify(actionAccountKey, {
      type: 'reply_sent',
      accountNickname: 'Ubot 1',
      channelTitle: 'BASE WIB',
      trigger: 'bucin',
      sourceMessageId: 77,
      sourceMessageLink: 'https://t.me/base_wib/77',
      reactionStatus: 'sent',
    })).resolves.toBe(true);

    expect(sentByAccount.get(actionAccountKey)).toEqual([{
      target: 'me',
      notification: {
        text: [
          '🤖 AUTO WTB SENT',
          '',
          'Account: Ubot 1',
          'Channel: BASE WIB',
          'Trigger: bucin',
          'Source message ID: 77',
          '',
          'Reply: SUCCESS',
          'Reaction: SENT',
        ].join('\n'),
        link: { label: '🔗 Open Source Message', url: 'https://t.me/base_wib/77' },
      },
    }]);
    expect(sentByAccount.get(otherAccountKey)).toBeUndefined();
  });

  it('keeps two accounts isolated and sends each failure report to its own Saved Messages', async () => {
    const sentByAccount = new Map<string, Array<{ target: string; notification: unknown }>>();
    const accountA = 'account-00000000-0000-4000-8000-000000000a01';
    const accountB = 'account-00000000-0000-4000-8000-000000000b02';
    const clients = new Map([
      [accountA, createConnectedNotificationClient(accountA, sentByAccount)],
      [accountB, createConnectedNotificationClient(accountB, sentByAccount)],
    ]);
    const accounts = { get: () => ({ enabled: true, nickname: 'Fallback' }) } as unknown as AccountService;
    const registry = { get: (key: string) => clients.get(key) } as unknown as TelegramClientRegistry;
    const gateway = new GramJsAccountNotificationGateway(accounts, registry);

    await gateway.notify(accountA, {
      type: 'reply_failed', channelTitle: 'A', trigger: 'bucin', sourceMessageId: 91,
      sourceMessageLink: 'https://t.me/a_channel/91', reason: 'FLOOD_WAIT_30',
    });
    await gateway.notify(accountB, {
      type: 'reply_failed', channelTitle: 'B', reason: 'CHAT_WRITE_FORBIDDEN',
    });

    expect(sentByAccount.get(accountA)?.[0]).toEqual({
      target: 'me',
      notification: {
        text: [
          '❌ AUTO WTB FAILED',
          '',
          'Account: Fallback',
          'Channel: A',
          'Trigger: bucin',
          'Source message ID: 91',
          '',
          'Reply: FAILED',
          'Reason: FLOOD_WAIT_30',
        ].join('\n'),
        link: { label: 'Open Source Message', url: 'https://t.me/a_channel/91' },
      },
    });
    expect(sentByAccount.get(accountB)?.[0]).toEqual({
      target: 'me',
      notification: {
        text: [
          '❌ AUTO WTB FAILED',
          '',
          'Account: Fallback',
          'Channel: B',
          '',
          'Reply: FAILED',
          'Reason: CHAT_WRITE_FORBIDDEN',
        ].join('\n'),
      },
    });
  });

  it('returns unavailable when the acting account is not connected', async () => {
    const accounts = { get: () => ({ enabled: true, nickname: 'Ubot' }) } as unknown as AccountService;
    const registry = { get: () => ({ getStatus: () => ({ connected: false }) }) } as unknown as TelegramClientRegistry;
    const gateway = new GramJsAccountNotificationGateway(accounts, registry);

    await expect(gateway.notify('missing-account', {
      type: 'reply_failed', channelTitle: 'BASE WIB', reason: 'simulated failure',
    })).resolves.toBe(false);
  });
});

function createConnectedNotificationClient(
  accountKey: string,
  sentByAccount: Map<string, Array<{ target: string; notification: unknown }>>,
) {
  return {
    getStatus: () => ({ connected: true }),
    sendOperationalNotification: (target: string, notification: unknown) => {
      const notifications = sentByAccount.get(accountKey) ?? [];
      notifications.push({ target, notification });
      sentByAccount.set(accountKey, notifications);
      return Promise.resolve();
    },
  };
}
