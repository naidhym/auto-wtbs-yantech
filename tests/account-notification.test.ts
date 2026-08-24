import { describe, expect, it } from 'vitest';

import type { AccountService } from '../src/accounts/account.service.js';
import type { AccountAutomationSettingsService } from '../src/automation/account-automation-settings.service.js';
import { GramJsAccountNotificationGateway } from '../src/automation/gramjs-auto-reply.gateway.js';
import type { TelegramClientRegistry } from '../src/user-client/telegram-client.registry.js';

describe('M6 account notification gateway', () => {
  it('sends an action account notification to its configured monitoring bot with the source-post link', async () => {
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
    const settings = createSettings(actionAccountKey, '@MonitoringBot');
    const gateway = new GramJsAccountNotificationGateway(accounts, registry, settings);

    await expect(gateway.notify(actionAccountKey, {
      type: 'reply_sent',
      accountNickname: 'Ubot 1',
      channelTitle: 'BASE WIB',
      trigger: 'bucin',
      sourceMessageLink: 'https://t.me/base_wib/77',
    })).resolves.toBe(true);

    expect(sentByAccount.get(actionAccountKey)).toEqual([{
      target: '@MonitoringBot',
      notification: {
        text: '🤖 AUTO WTB SENT\n\nAccount: Ubot 1\nChannel: BASE WIB\nTrigger: bucin',
        link: { label: '🔗 Open Source Message', url: 'https://t.me/base_wib/77' },
      },
    }]);
    expect(sentByAccount.get(otherAccountKey)).toBeUndefined();
  });

  it('allows separate accounts to use separate targets and does not use Saved Messages', async () => {
    const sentByAccount = new Map<string, Array<{ target: string; notification: unknown }>>();
    const accountA = 'account-00000000-0000-4000-8000-000000000a01';
    const accountB = 'account-00000000-0000-4000-8000-000000000b02';
    const clients = new Map([
      [accountA, createConnectedNotificationClient(accountA, sentByAccount)],
      [accountB, createConnectedNotificationClient(accountB, sentByAccount)],
    ]);
    const accounts = { get: () => ({ enabled: true, nickname: 'Fallback' }) } as unknown as AccountService;
    const registry = { get: (key: string) => clients.get(key) } as unknown as TelegramClientRegistry;
    const settings = {
      get: (key: string) => ({ notificationTarget: key === accountA ? '@BotA' : '@BotB' }),
    } as unknown as AccountAutomationSettingsService;
    const gateway = new GramJsAccountNotificationGateway(accounts, registry, settings);

    await gateway.notify(accountA, { type: 'reply_failed', channelTitle: 'A', reason: 'failed' });
    await gateway.notify(accountB, { type: 'reply_failed', channelTitle: 'B', reason: 'failed' });

    expect(sentByAccount.get(accountA)?.[0]?.target).toBe('@BotA');
    expect(sentByAccount.get(accountB)?.[0]?.target).toBe('@BotB');
    expect([...sentByAccount.values()].flat().some(({ target }) => target === 'me')).toBe(false);
  });

  it('returns unavailable when the account lacks a configured target', async () => {
    const accounts = { get: () => ({ enabled: true, nickname: 'Ubot' }) } as unknown as AccountService;
    const registry = { get: () => ({ getStatus: () => ({ connected: true }) }) } as unknown as TelegramClientRegistry;
    const settings = createSettings('missing-account', undefined);
    const gateway = new GramJsAccountNotificationGateway(accounts, registry, settings);

    await expect(gateway.notify('missing-account', {
      type: 'reply_failed', channelTitle: 'BASE WIB', reason: 'simulated failure',
    })).resolves.toBe(false);
  });
});

function createSettings(accountKey: string, notificationTarget: string | undefined) {
  return {
    get: (key: string) => {
      if (key !== accountKey) throw new Error('Unexpected account');
      return { notificationTarget };
    },
  } as unknown as AccountAutomationSettingsService;
}

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
