import { describe, expect, it, vi } from 'vitest';

import type { AccountRecord } from '../src/accounts/account.types.js';
import type { AutoReplyGateway } from '../src/automation/automation.types.js';
import type { ChannelRecord } from '../src/channels/channel.types.js';
import type { DispatchJob } from '../src/detection/dispatch-job.js';
import type { AppLogger } from '../src/logging/logger.js';
import {
  ReplyConfigurationService,
  type ReplyExecutionConfiguration,
} from '../src/reply/reply-configuration.service.js';
import { classifyReplyError } from '../src/reply/reply-error.js';
import { ReplyExecutor, type DelayScheduler } from '../src/reply/reply.executor.js';
import type { ReplyTemplateRecord } from '../src/rules/rule.types.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as AppLogger;

function account(id: number, enabled = true): AccountRecord {
  return {
    id,
    ownerId: 1,
    accountKey: `account-${id}`,
    nickname: `Account ${id}`,
    label: `Account ${id}`,
    phoneNumber: `+62800000000${id}`,
    status: enabled ? 'connected' : 'disabled',
    enabled,
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
  };
}

function channel(id: number, telegramChannelId = `-100900${id}`): ChannelRecord {
  return {
    id,
    telegramChannelId,
    title: `Channel ${id}`,
    enabled: true,
    status: 'healthy',
    automationBlocked: false,
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
  };
}

function template(id: number, accountId = id): ReplyTemplateRecord {
  return {
    id,
    accountId,
    accountKey: `account-${accountId}`,
    accountNickname: `Account ${accountId}`,
    name: `Template ${accountId}`,
    body: `Reply from account ${accountId}`,
    enabled: true,
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
  };
}

function job(accountId = 1, channelId = 5, sourceMessageId = 100): DispatchJob {
  return {
    accountId,
    channelId,
    sourceMessageId,
    matchedTriggers: ['bucin', 'mensive'],
    sourceText: 'bucin mensive',
    senderDisplayName: 'Sender',
    timestamp: new Date('2026-08-27T00:00:00.000Z'),
  };
}

interface HarnessOptions {
  readonly accounts?: ReadonlyMap<number, AccountRecord>;
  readonly channels?: ReadonlyMap<number, ChannelRecord>;
  readonly templates?: ReadonlyMap<string, ReplyTemplateRecord | undefined>;
  readonly delays?: ReadonlyMap<string, number>;
  readonly scheduler?: DelayScheduler;
  readonly available?: (accountKey: string) => boolean;
  readonly send?: AutoReplyGateway['sendComment'];
}

function createHarness(options: HarnessOptions = {}) {
  const accounts = options.accounts ?? new Map([[1, account(1)]]);
  const channels = options.channels ?? new Map([[5, channel(5, '-100777')]]);
  const templates = options.templates ?? new Map([['account-1', template(41, 1)]]);
  const delays = options.delays ?? new Map([['account-1', 1_500]]);
  const scheduler = options.scheduler ?? { wait: vi.fn().mockResolvedValue(undefined) };
  const sendComment = vi.fn(options.send ?? (() => Promise.resolve({
    messageId: 200,
    resolveMessageLink: () => Promise.resolve('https://t.me/c/777/200'),
  })));
  const reactToSourceMessage = vi.fn();
  const gateway: AutoReplyGateway = {
    isAvailable: vi.fn(options.available ?? (() => true)),
    sendComment,
    reactToSourceMessage,
  };
  const configuration = new ReplyConfigurationService(
    { getById: (accountId) => accounts.get(accountId) },
    { get: (channelId) => channels.get(channelId) },
    { getActiveTemplate: (accountKey) => templates.get(accountKey) },
    {
      get: (accountKey) => {
        const target = [...accounts.values()].find((value) => value.accountKey === accountKey);
        if (target === undefined) throw new Error(`Account not found: ${accountKey}`);
        return {
          accountId: target.id,
          accountKey,
          accountNickname: target.nickname,
          replyDelayMs: delays.get(accountKey) ?? 100,
          autoReaction: false,
          reactionType: '❤️',
          cooldownMs: 0,
          hourlyLimit: 0,
          dailyLimit: 0,
          updatedAt: '2026-08-27T00:00:00.000Z',
        };
      },
    },
  );
  return {
    configuration,
    gateway,
    scheduler,
    sendComment,
    reactToSourceMessage,
    executor: new ReplyExecutor(configuration, gateway, logger, scheduler),
  };
}

describe('reply configuration', () => {
  it('resolves the target account template, decimal delay, and real Telegram peer', () => {
    const harness = createHarness();
    expect(harness.configuration.resolve(job())).toEqual<ReplyExecutionConfiguration>({
      accountKey: 'account-1',
      channelIdentifier: '-100777',
      templateId: 41,
      templateBody: 'Reply from account 1',
      delayMs: 1_500,
    });
  });

  it.each([99, 600_001, 100.5, Number.NaN])(
    'rejects invalid stored reply delay %s',
    async (delayMs) => {
      const harness = createHarness({ delays: new Map([['account-1', delayMs]]) });
      await expect(harness.executor.execute(job())).resolves.toMatchObject({
        success: false,
        errorCode: 'INVALID_REPLY_DELAY',
      });
      expect(harness.sendComment).not.toHaveBeenCalled();
    },
  );

  it('rejects a template owned by another account', async () => {
    const harness = createHarness({
      templates: new Map([['account-1', template(42, 2)]]),
    });
    await expect(harness.executor.execute(job())).resolves.toMatchObject({
      success: false,
      errorCode: 'ACCOUNT_CONFIGURATION_MISMATCH',
    });
  });

  it('returns deterministic failures for missing account, channel, and template', async () => {
    const missingAccount = createHarness({ accounts: new Map() });
    const missingChannel = createHarness({ channels: new Map() });
    const missingTemplate = createHarness({
      templates: new Map([['account-1', undefined]]),
    });

    await expect(missingAccount.executor.execute(job())).resolves.toMatchObject({
      errorCode: 'ACCOUNT_NOT_FOUND',
    });
    await expect(missingChannel.executor.execute(job())).resolves.toMatchObject({
      errorCode: 'CHANNEL_NOT_FOUND',
    });
    await expect(missingTemplate.executor.execute(job())).resolves.toMatchObject({
      errorCode: 'ACTIVE_TEMPLATE_NOT_FOUND',
    });
  });
});

describe('reply executor', () => {
  it('returns the exact Telegram reply ID and replies to the original source post', async () => {
    const wait = vi.fn().mockResolvedValue(undefined);
    const harness = createHarness({ scheduler: { wait } });
    const result = await harness.executor.execute(job());

    expect(result).toMatchObject({
      success: true,
      accountId: 1,
      channelId: 5,
      sourceMessageId: 100,
      replyMessageId: 200,
      matchedTriggers: ['bucin', 'mensive'],
    });
    expect(result.errorCode).toBeUndefined();
    expect(Number.isNaN(Date.parse(result.executedAt))).toBe(false);
    expect(wait).toHaveBeenCalledWith(1_500, expect.any(AbortSignal));
    expect(harness.sendComment).toHaveBeenCalledOnce();
    expect(harness.sendComment).toHaveBeenCalledWith(
      'account-1',
      '-100777',
      100,
      'Reply from account 1',
    );
    expect(harness.reactToSourceMessage).not.toHaveBeenCalled();
  });

  it('does not let a delayed account block another account', async () => {
    let releaseSlow: (() => void) | undefined;
    const scheduler: DelayScheduler = {
      wait: vi.fn((delayMs) => delayMs === 5_000
        ? new Promise<void>((resolve) => { releaseSlow = resolve; })
        : Promise.resolve()),
    };
    const sends: string[] = [];
    const harness = createHarness({
      accounts: new Map([[1, account(1)], [2, account(2)]]),
      templates: new Map([
        ['account-1', template(41, 1)],
        ['account-2', template(42, 2)],
      ]),
      delays: new Map([['account-1', 5_000], ['account-2', 100]]),
      scheduler,
      send: (accountKey) => {
        sends.push(accountKey);
        return Promise.resolve({
          messageId: accountKey === 'account-1' ? 201 : 202,
          resolveMessageLink: () => Promise.resolve(''),
        });
      },
    });

    const slow = harness.executor.execute(job(1, 5, 101));
    const fast = harness.executor.execute(job(2, 5, 102));
    await expect(fast).resolves.toMatchObject({ success: true, replyMessageId: 202 });
    expect(sends).toEqual(['account-2']);
    releaseSlow?.();
    await expect(slow).resolves.toMatchObject({ success: true, replyMessageId: 201 });
    expect(sends).toEqual(['account-2', 'account-1']);
  });

  it('keeps one account success when another account fails', async () => {
    const harness = createHarness({
      accounts: new Map([[1, account(1)], [2, account(2)]]),
      templates: new Map([
        ['account-1', template(41, 1)],
        ['account-2', template(42, 2)],
      ]),
      delays: new Map([['account-1', 100], ['account-2', 100]]),
      send: (accountKey) => {
        if (accountKey === 'account-1') return Promise.reject(new Error('CHANNEL_PRIVATE'));
        return Promise.resolve({
          messageId: 222,
          resolveMessageLink: () => Promise.resolve(''),
        });
      },
    });

    const results = await harness.executor.executeAll([
      job(1, 5, 110),
      job(2, 5, 110),
    ]);
    expect(results).toEqual([
      expect.objectContaining({
        success: false,
        accountId: 1,
        errorCode: 'TELEGRAM_PERMISSION_DENIED',
        errorMessage: 'CHANNEL_PRIVATE',
      }),
      expect.objectContaining({ success: true, accountId: 2, replyMessageId: 222 }),
    ]);
  });

  it('executes the same DispatchJob only once, including after completion', async () => {
    const harness = createHarness();
    const first = harness.executor.execute(job());
    const concurrentDuplicate = harness.executor.execute(job());
    expect(concurrentDuplicate).toBe(first);
    const firstResult = await first;
    const completedDuplicate = harness.executor.execute(job());
    expect(completedDuplicate).toBe(first);
    await expect(completedDuplicate).resolves.toBe(firstResult);
    expect(harness.sendComment).toHaveBeenCalledOnce();
  });

  it('serializes jobs for the same account while preserving source order', async () => {
    const order: number[] = [];
    const harness = createHarness({
      send: (_accountKey, _channelIdentifier, sourceMessageId) => {
        order.push(sourceMessageId);
        return Promise.resolve({
          messageId: sourceMessageId + 1_000,
          resolveMessageLink: () => Promise.resolve(''),
        });
      },
    });
    await harness.executor.executeAll([
      job(1, 5, 120),
      job(1, 5, 121),
      job(1, 5, 122),
    ]);
    expect(order).toEqual([120, 121, 122]);
  });

  it('preserves Telegram failure details and never fabricates a reply ID', async () => {
    const telegramError = Object.assign(new Error('A wait of 37 seconds is required'), {
      code: 420,
      errorMessage: 'FLOOD_WAIT_37',
    });
    const harness = createHarness({ send: () => Promise.reject(telegramError) });
    const result = await harness.executor.execute(job());
    expect(result).toMatchObject({
      success: false,
      errorCode: 'FLOOD_WAIT',
      errorMessage: 'A wait of 37 seconds is required',
    });
    expect(result.replyMessageId).toBeUndefined();
  });

  it('fails when Telegram does not return the created reply message ID', async () => {
    const harness = createHarness({
      send: () => Promise.resolve({
        messageId: 0,
        resolveMessageLink: () => Promise.resolve(''),
      }),
    });
    const result = await harness.executor.execute(job());
    expect(result).toMatchObject({
      success: false,
      errorCode: 'REPLY_MESSAGE_ID_MISSING',
    });
    expect(result.replyMessageId).toBeUndefined();
  });

  it('does not send when the account disconnects during its delay', async () => {
    const harness = createHarness({ available: () => false });
    await expect(harness.executor.execute(job())).resolves.toMatchObject({
      success: false,
      errorCode: 'ACCOUNT_DISCONNECTED',
    });
    expect(harness.sendComment).not.toHaveBeenCalled();
  });

  it('aborts delayed work during shutdown without sending', async () => {
    const harness = createHarness({ delays: new Map([['account-1', 60_000]]) });
    const execution = harness.executor.execute(job());
    await Promise.resolve();
    harness.executor.shutdown();
    await expect(execution).resolves.toMatchObject({
      success: false,
      errorCode: 'EXECUTION_ABORTED',
    });
    expect(harness.sendComment).not.toHaveBeenCalled();
  });

  it('rejects an invalid source message ID before resolving configuration', async () => {
    const harness = createHarness();
    await expect(harness.executor.execute(job(1, 5, 0))).resolves.toMatchObject({
      success: false,
      errorCode: 'INVALID_SOURCE_MESSAGE_ID',
    });
    expect(harness.sendComment).not.toHaveBeenCalled();
  });
});

describe('reply error classification', () => {
  it.each([
    ['MSG_ID_INVALID', 'SOURCE_MESSAGE_UNAVAILABLE'],
    ['COMMENTS_DISABLED', 'COMMENT_UNAVAILABLE'],
    ['CHAT_WRITE_FORBIDDEN', 'TELEGRAM_PERMISSION_DENIED'],
    ['Could not find the input entity', 'INVALID_ENTITY'],
    ['Telegram client is not connected', 'ACCOUNT_DISCONNECTED'],
    ['socket connection reset', 'CONNECTION_FAILED'],
    ['request timed out', 'TIMEOUT'],
  ] as const)('classifies %s as %s', (message, errorCode) => {
    expect(classifyReplyError(new Error(message))).toEqual({ errorCode, errorMessage: message });
  });
});
