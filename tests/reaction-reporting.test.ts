import pino from 'pino';
import { describe, expect, it } from 'vitest';

import type { AccountRecord } from '../src/accounts/account.types.js';
import type { AccountAutomationSettings } from '../src/automation/automation.types.js';
import type { ChannelRecord } from '../src/channels/channel.types.js';
import { ReactionConfigurationService } from '../src/reaction/reaction-configuration.service.js';
import { ReactionExecutor } from '../src/reaction/reaction.executor.js';
import type {
  ReplyReactionGateway,
  ReplyReactionTarget,
} from '../src/reaction/reaction-result.js';
import type { ReplyResult } from '../src/reply/reply-result.js';
import type {
  SavedMessagesGateway,
  SavedMessagesPayload,
} from '../src/reporting/action-report.js';
import { ActionReporter } from '../src/reporting/action-reporter.js';
import { Phase5ExecutionService } from '../src/reporting/phase5-execution.service.js';

const logger = pino({ level: 'silent' });
const timestamp = '2026-08-27T00:00:00.000Z';

interface ReactionCall {
  readonly accountKey: string;
  readonly target: ReplyReactionTarget;
}

interface SavedCall {
  readonly accountKey: string;
  readonly payload: SavedMessagesPayload;
}

interface HarnessOptions {
  readonly autoReaction?: Readonly<Record<string, boolean>>;
  readonly reactionType?: Readonly<Record<string, string>>;
  readonly reactionFailures?: Readonly<Record<string, string>>;
  readonly reportFailures?: readonly string[];
  readonly includeDraco?: boolean;
}

function account(id: number, accountKey: string, nickname: string): AccountRecord {
  return {
    id,
    ownerId: 1,
    accountKey,
    nickname,
    label: nickname,
    phoneNumber: `+62800000000${String(id)}`,
    status: 'connected',
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function channel(): ChannelRecord {
  return {
    id: 5,
    telegramChannelId: '-100777',
    username: 'base_wtb_test',
    title: 'BASE WTB',
    enabled: true,
    status: 'healthy',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function settings(
  target: AccountRecord,
  autoReaction: boolean,
  reactionType: string,
): AccountAutomationSettings {
  return {
    accountId: target.id,
    accountKey: target.accountKey,
    accountNickname: target.nickname,
    replyDelayMs: 1_500,
    autoReaction,
    reactionType,
    cooldownMs: 0,
    hourlyLimit: 0,
    dailyLimit: 0,
    updatedAt: timestamp,
  };
}

function successfulReply(
  accountId = 1,
  sourceMessageId = 100,
  replyMessageId = 200,
): ReplyResult {
  return {
    success: true,
    accountId,
    channelId: 5,
    sourceMessageId,
    replyMessageId,
    matchedTriggers: ['bucin', 'mensive'],
    executedAt: timestamp,
  };
}

function failedReply(accountId = 1): ReplyResult {
  return {
    success: false,
    accountId,
    channelId: 5,
    sourceMessageId: 100,
    matchedTriggers: ['bucin'],
    errorCode: 'TELEGRAM_PERMISSION_DENIED',
    errorMessage: 'CHAT_WRITE_FORBIDDEN for this account',
    executedAt: timestamp,
  };
}

function createHarness(options: HarnessOptions = {}) {
  const shark = account(1, 'shark', 'Shark');
  const draco = account(2, 'draco', 'Draco');
  const accounts = new Map<number, AccountRecord>([[shark.id, shark]]);
  if (options.includeDraco === true) accounts.set(draco.id, draco);
  const accountSettings = new Map<string, AccountAutomationSettings>();
  for (const value of accounts.values()) {
    accountSettings.set(value.accountKey, settings(
      value,
      options.autoReaction?.[value.accountKey] ?? true,
      options.reactionType?.[value.accountKey] ?? '❤️',
    ));
  }
  const channels = new Map<number, ChannelRecord>([[5, channel()]]);
  const reactionCalls: ReactionCall[] = [];
  const savedCalls: SavedCall[] = [];
  const reactionGateway: ReplyReactionGateway = {
    reactToReply(accountKey, target) {
      reactionCalls.push({ accountKey, target });
      const failure = options.reactionFailures?.[accountKey];
      if (failure !== undefined) return Promise.reject(new Error(failure));
      return Promise.resolve({ status: 'sent' });
    },
  };
  const savedMessages: SavedMessagesGateway = {
    sendToSavedMessages(accountKey, payload) {
      savedCalls.push({ accountKey, payload });
      if (options.reportFailures?.includes(accountKey) === true) {
        return Promise.reject(new Error(`Saved Messages unavailable for ${accountKey}`));
      }
      return Promise.resolve();
    },
  };
  const reactions = new ReactionExecutor(
    new ReactionConfigurationService(
      { getById: (accountId) => accounts.get(accountId) },
      { get: (channelId) => channels.get(channelId) },
      {
        get: (accountKey) => {
          const value = accountSettings.get(accountKey);
          if (value === undefined) throw new Error(`Settings not found: ${accountKey}`);
          return value;
        },
      },
    ),
    reactionGateway,
    logger,
  );
  const reporter = new ActionReporter(
    { getById: (accountId) => accounts.get(accountId) },
    { get: (channelId) => channels.get(channelId) },
    savedMessages,
    logger,
  );
  return {
    reactions,
    service: new Phase5ExecutionService(reactions, reporter),
    reactionCalls,
    savedCalls,
  };
}

const context = {
  senderDisplayName: 'Seller Display Name',
  delayMs: 1_500,
  sourceMessageLink: 'https://t.me/base_wtb_test/100',
};

describe('Phase 5 reaction execution', () => {
  it('1. skips reaction when the executing account has reaction OFF', async () => {
    const harness = createHarness({ autoReaction: { shark: false } });
    const result = await harness.reactions.execute(successfulReply());
    expect(result).toMatchObject({ status: 'disabled', attempted: false, success: true });
    expect(harness.reactionCalls).toHaveLength(0);
  });

  it('2. attempts reaction when the executing account has reaction ON', async () => {
    const harness = createHarness();
    const result = await harness.reactions.execute(successfulReply());
    expect(result.attempted).toBe(true);
    expect(harness.reactionCalls).toHaveLength(1);
  });

  it('3. uses the configured per-account reaction type', async () => {
    const harness = createHarness({ reactionType: { shark: '👍' } });
    await harness.reactions.execute(successfulReply());
    expect(harness.reactionCalls[0]?.target.reactionType).toBe('👍');
  });

  it('4. targets replyMessageId', async () => {
    const harness = createHarness();
    await harness.reactions.execute(successfulReply(1, 100, 200));
    expect(harness.reactionCalls[0]?.target.replyMessageId).toBe(200);
  });

  it('5. never substitutes sourceMessageId as the reaction target', async () => {
    const harness = createHarness();
    await harness.reactions.execute(successfulReply(1, 100, 200));
    expect(harness.reactionCalls[0]?.target.replyMessageId).not.toBe(100);
  });

  it('6. carries the channel context used to locate the exact sent-reply peer', async () => {
    const harness = createHarness();
    await harness.reactions.execute(successfulReply());
    expect(harness.reactionCalls[0]?.target).toMatchObject({
      channelIdentifier: '-100777',
      replyMessageId: 200,
    });
  });

  it('7. returns a stable successful ReactionResult', async () => {
    const harness = createHarness();
    const result = await harness.reactions.execute(successfulReply());
    expect(result).toMatchObject({
      status: 'sent',
      attempted: true,
      success: true,
      reactionType: '❤️',
      targetMessageId: 200,
    });
    expect(result.executedAt).toEqual(expect.any(String));
  });

  it('8. preserves a stable class and the actual reaction failure', async () => {
    const harness = createHarness({
      reactionFailures: { shark: 'FLOOD_WAIT_23 while reacting to reply 200' },
    });
    const result = await harness.reactions.execute(successfulReply());
    expect(result).toMatchObject({
      status: 'failed',
      attempted: true,
      success: false,
      errorCode: 'FLOOD_WAIT',
      errorMessage: 'FLOOD_WAIT_23 while reacting to reply 200',
    });
  });

  it('9. prevents reaction after reply failure', async () => {
    const harness = createHarness();
    const result = await harness.reactions.execute(failedReply());
    expect(result).toMatchObject({
      status: 'not_applicable',
      attempted: false,
      success: false,
      skippedReason: 'reply_failed',
    });
    expect(harness.reactionCalls).toHaveLength(0);
  });
});

describe('Phase 5 exactly-once reporting and account isolation', () => {
  it('10. emits one report for reply success plus reaction failure', async () => {
    const harness = createHarness({ reactionFailures: { shark: 'REACTION_INVALID' } });
    const reply = successfulReply();
    const [first, second] = await Promise.all([
      harness.service.process({ reply, context }),
      harness.service.process({ reply, context }),
    ]);
    expect(first).toBe(second);
    expect(harness.savedCalls).toHaveLength(1);
    expect(first.reaction.status).toBe('failed');
  });

  it('11. emits one report for reply success plus disabled reaction', async () => {
    const harness = createHarness({ autoReaction: { shark: false } });
    const result = await harness.service.process({ reply: successfulReply(), context });
    expect(harness.savedCalls).toHaveLength(1);
    expect(result.report.report?.reactionStatus).toBe('disabled');
  });

  it('12. emits one report for reply failure', async () => {
    const harness = createHarness();
    const result = await harness.service.process({ reply: failedReply(), context });
    expect(harness.savedCalls).toHaveLength(1);
    expect(result.report.report).toMatchObject({
      replyStatus: 'failed',
      reactionStatus: 'not_applicable',
    });
  });

  it('13. addresses Saved Messages through the executing account key', async () => {
    const harness = createHarness();
    await harness.service.process({ reply: successfulReply(), context });
    expect(harness.savedCalls[0]?.accountKey).toBe('shark');
  });

  it('14. sends the Shark report only through Shark', async () => {
    const harness = createHarness({ includeDraco: true });
    await harness.service.process({ reply: successfulReply(1), context });
    expect(harness.savedCalls.map((call) => call.accountKey)).toEqual(['shark']);
  });

  it('15. sends the Draco report only through Draco', async () => {
    const harness = createHarness({ includeDraco: true });
    await harness.service.process({ reply: successfulReply(2, 101, 201), context });
    expect(harness.savedCalls.map((call) => call.accountKey)).toEqual(['draco']);
  });

  it('16. includes the original source message ID and available link', async () => {
    const harness = createHarness();
    const result = await harness.service.process({ reply: successfulReply(), context });
    expect(result.report.report).toMatchObject({
      sourceMessageId: 100,
      sourceMessageLink: 'https://t.me/base_wtb_test/100',
    });
    expect(harness.savedCalls[0]?.payload.text).toContain('https://t.me/base_wtb_test/100');
  });

  it('17. includes replyMessageId for a successful reply', async () => {
    const harness = createHarness();
    const result = await harness.service.process({ reply: successfulReply(), context });
    expect(result.report.report?.replyMessageId).toBe(200);
    expect(harness.savedCalls[0]?.payload.text).toContain('Reply message ID: 200');
  });

  it('18. includes reaction status and configured type', async () => {
    const harness = createHarness({ reactionType: { shark: '👍' } });
    const result = await harness.service.process({ reply: successfulReply(), context });
    expect(result.report.report).toMatchObject({ reactionStatus: 'sent', reactionType: '👍' });
    expect(harness.savedCalls[0]?.payload.text).toContain('Reaction type: 👍');
  });

  it('19. includes the actual failure reason instead of a generic replacement', async () => {
    const harness = createHarness({
      reactionFailures: { shark: 'CHAT_WRITE_FORBIDDEN on linked discussion peer' },
    });
    const result = await harness.service.process({ reply: successfulReply(), context });
    expect(result.report.report?.reactionErrorMessage)
      .toBe('CHAT_WRITE_FORBIDDEN on linked discussion peer');
    expect(harness.savedCalls[0]?.payload.text)
      .toContain('CHAT_WRITE_FORBIDDEN on linked discussion peer');
  });

  it('20. reaction failure cannot create a duplicate reply or post-processing run', async () => {
    const harness = createHarness({ reactionFailures: { shark: 'REACTION_INVALID' } });
    const reply = successfulReply();
    const first = await harness.service.process({ reply, context });
    const second = await harness.service.process({ reply, context });
    expect(first.reply).toBe(reply);
    expect(second.reply).toBe(reply);
    expect(harness.reactionCalls).toHaveLength(1);
    expect(harness.savedCalls).toHaveLength(1);
  });

  it('21. report failure preserves the successful reply without retrying it', async () => {
    const harness = createHarness({ reportFailures: ['shark'] });
    const reply = successfulReply();
    const result = await harness.service.process({ reply, context });
    expect(result.reply).toBe(reply);
    expect(result.reply.success).toBe(true);
    expect(result.report).toMatchObject({
      delivered: false,
      errorCode: 'REPORT_DELIVERY_FAILED',
    });
    expect(harness.reactionCalls).toHaveLength(1);
    expect(harness.savedCalls).toHaveLength(1);
  });

  it('22. keeps concurrent Shark and Draco results isolated', async () => {
    const harness = createHarness({
      includeDraco: true,
      reactionType: { shark: '❤️', draco: '👍' },
    });
    const results = await harness.service.processAll([
      { reply: successfulReply(1, 100, 200), context },
      { reply: successfulReply(2, 100, 300), context },
    ]);
    expect(results.map((result) => result.reaction.reactionType)).toEqual(['❤️', '👍']);
    expect(harness.savedCalls.map((call) => call.accountKey).sort()).toEqual(['draco', 'shark']);
  });

  it('23. one account reaction failure does not affect the other account', async () => {
    const harness = createHarness({
      includeDraco: true,
      reactionFailures: { shark: 'FLOOD_WAIT_9' },
    });
    const results = await harness.service.processAll([
      { reply: successfulReply(1, 100, 200), context },
      { reply: successfulReply(2, 100, 300), context },
    ]);
    expect(results.map((result) => result.reaction.status)).toEqual(['failed', 'sent']);
    expect(results.map((result) => result.report.delivered)).toEqual([true, true]);
  });

  it('24. one account report failure does not affect the other account', async () => {
    const harness = createHarness({ includeDraco: true, reportFailures: ['shark'] });
    const results = await harness.service.processAll([
      { reply: successfulReply(1, 100, 200), context },
      { reply: successfulReply(2, 100, 300), context },
    ]);
    expect(results.map((result) => result.report.delivered)).toEqual([false, true]);
    expect(results.map((result) => result.reply.success)).toEqual([true, true]);
    expect(harness.savedCalls.map((call) => call.accountKey).sort()).toEqual(['draco', 'shark']);
  });
});
