import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { AccountRepository } from '../src/accounts/account.repository.js';
import { AccountService } from '../src/accounts/account.service.js';
import { AccountAutomationSettingsRepository } from '../src/automation/account-automation-settings.repository.js';
import {
  AccountAutomationSettingsService,
  parseSecondsToMilliseconds,
} from '../src/automation/account-automation-settings.service.js';
import { AutomationDispatchRepository } from '../src/automation/automation-dispatch.repository.js';
import { AutomationSafetyService } from '../src/automation/automation-safety.service.js';
import { AutoReplyService } from '../src/automation/auto-reply.service.js';
import type {
  AccountNotification,
  AccountNotificationGateway,
  AutoReplyGateway,
  DelayScheduler,
  OwnerNotification,
  OwnerNotificationGateway,
} from '../src/automation/automation.types.js';
import { ChannelListenerService } from '../src/channels/channel-listener.service.js';
import { ChannelRepository } from '../src/channels/channel.repository.js';
import { ChannelService } from '../src/channels/channel.service.js';
import type {
  ChannelAccessGateway,
  ChannelAssignmentRecord,
  ChannelRecord,
  ResolvedTelegramChannel,
} from '../src/channels/channel.types.js';
import { DatabaseService } from '../src/database/database.service.js';
import { EventLogRepository } from '../src/logging/event-log.repository.js';
import { createLogger } from '../src/logging/logger.js';
import { DetectionPipelineService } from '../src/rules/detection-pipeline.service.js';
import { DetectionService } from '../src/rules/detection.service.js';
import { GlobalDetectionService } from '../src/rules/global-detection.service.js';
import { GlobalKeywordService } from '../src/rules/global-keyword.service.js';
import { ReplyTemplateRepository } from '../src/rules/reply-template.repository.js';
import { ReplyTemplateService } from '../src/rules/reply-template.service.js';
import { RuleRepository } from '../src/rules/rule.repository.js';
import type { TelegramChatKind, TelegramIncomingMessage } from '../src/rules/rule.types.js';

const OWNER = '123456789';
const ACCOUNT_A = 'account-00000000-0000-4000-8000-000000000a01';
const ACCOUNT_B = 'account-00000000-0000-4000-8000-000000000b02';
const ACCOUNT_C = 'account-00000000-0000-4000-8000-000000000c03';

class FakeListenerGateway implements ChannelAccessGateway {
  public stopped: number[] = [];

  public resolve(_accountKey: string, identifier: string): Promise<ResolvedTelegramChannel> {
    return Promise.resolve({ telegramChannelId: identifier, title: identifier });
  }

  public subscribe(
    _accountKey: string,
    _assignment: ChannelAssignmentRecord,
    channel: ChannelRecord,
  ): Promise<() => Promise<void>> {
    return Promise.resolve(() => {
      this.stopped.push(channel.id);
      return Promise.resolve();
    });
  }
}

class FakeAutoReplyGateway implements AutoReplyGateway {
  public sends: Array<{
    accountKey: string;
    channelIdentifier: string;
    sourceMessageId: number;
    text: string;
  }> = [];
  public reactions: Array<{
    accountKey: string;
    channelIdentifier: string;
    replyMessageId: number;
  }> = [];
  public reactionMode: 'sent' | 'skipped' | 'failed' = 'sent';
  public linkMode: 'available' | 'unavailable' = 'available';
  public failureReasons = new Map<string, string>();
  public unavailable = new Set<string>();
  public nextReplyMessageId = 5_001;

  public isAvailable(accountKey: string): boolean { return !this.unavailable.has(accountKey); }

  public sendComment(
    accountKey: string,
    channelIdentifier: string,
    sourceMessageId: number,
    text: string,
  ) {
    this.sends.push({ accountKey, channelIdentifier, sourceMessageId, text });
    const configuredFailure = this.failureReasons.get(accountKey);
    if (configuredFailure !== undefined) return Promise.reject(new Error(configuredFailure));
    const messageId = this.nextReplyMessageId;
    this.nextReplyMessageId += 1;
    return Promise.resolve({
      messageId,
      resolveMessageLink: () => this.linkMode === 'available'
        ? Promise.resolve(`https://t.me/c/900/${messageId}`)
        : Promise.reject(new Error('LINK_UNAVAILABLE')),
    });
  }

  public reactToSourceMessage(accountKey: string, target: { channelIdentifier: string; replyMessageId: number }) {
    this.reactions.push({ accountKey, channelIdentifier: target.channelIdentifier, replyMessageId: target.replyMessageId });
    if (this.reactionMode === 'skipped') {
      return Promise.resolve({ status: 'skipped' as const, reason: 'chat_reactions_none' });
    }
    if (this.reactionMode === 'failed') return Promise.reject(new Error('REACTION_NETWORK_FAIL'));
    return Promise.resolve({ status: 'sent' as const });
  }
}

class FakeNotifier implements AccountNotificationGateway {
  public notifications: Array<{
    accountKey: string;
    notification: AccountNotification;
  }> = [];
  public mode: 'sent' | 'unavailable' | 'failed' = 'sent';
  public notify(accountKey: string, notification: AccountNotification): Promise<boolean> {
    this.notifications.push({ accountKey, notification });
    if (this.mode === 'failed') return Promise.reject(new Error('NOTIFICATION_FAILED'));
    return Promise.resolve(this.mode === 'sent');
  }
}

class FakeSafetyNotifier implements OwnerNotificationGateway {
  public notifications: OwnerNotification[] = [];
  public notify(notification: OwnerNotification): Promise<boolean> {
    this.notifications.push(notification);
    return Promise.resolve(true);
  }
}

class ImmediateScheduler implements DelayScheduler {
  public waits: number[] = [];
  public wait(milliseconds: number): Promise<void> {
    this.waits.push(milliseconds);
    return Promise.resolve();
  }
}

class BlockingScheduler implements DelayScheduler {
  public readonly started: Promise<void>;
  private resolveStarted!: () => void;

  public constructor() {
    this.started = new Promise((resolve) => {
      this.resolveStarted = resolve;
    });
  }

  public wait(_milliseconds: number, signal?: AbortSignal): Promise<void> {
    this.resolveStarted();
    if (signal?.aborted === true) return Promise.resolve();
    return new Promise((resolve) => {
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
  }
}

describe('M5 auto reply and safety', () => {
  it('persists a monitoring-bot target independently for each account', () => {
    const harness = createHarness();
    harness.settings.setNotificationTarget(ACCOUNT_A, '@MonitorOneBot');
    harness.settings.setNotificationTarget(ACCOUNT_B, '@MonitorTwoBot');

    const reloaded = new AccountAutomationSettingsService(
      new AccountAutomationSettingsRepository(harness.connection),
      OWNER,
      harness.logger.logger,
    );
    expect(reloaded.get(ACCOUNT_A).notificationTarget).toBe('@MonitorOneBot');
    expect(reloaded.get(ACCOUNT_B).notificationTarget).toBe('@MonitorTwoBot');
    harness.close();
  });

  it.each<TelegramChatKind>(['group', 'supergroup', 'discussion', 'private', 'unknown'])(
    'never executes for %s events',
    async (chatKind) => {
      const harness = createHarness();
      await harness.process(1, 1, { chatKind, text: 'bucin', sourceMessageId: 100 });
      expect(harness.telegram.sends).toHaveLength(0);
      harness.close();
    },
  );

  it('requires a global trigger, lets exclude win, and sends only once deterministically', async () => {
    const harness = createHarness();
    await harness.process(1, 1, { text: 'ordinary post', sourceMessageId: 101 });
    await harness.process(1, 1, { text: 'bucin + FMV', sourceMessageId: 102 });
    expect(harness.telegram.sends).toHaveLength(0);

    await harness.process(1, 1, { text: 'Open BUCIN today', sourceMessageId: 103 });
    await harness.process(2, 1, { text: 'Open BUCIN today', sourceMessageId: 103 });
    expect(harness.telegram.sends).toEqual([
      expect.objectContaining({
        accountKey: ACCOUNT_A,
        sourceMessageId: 103,
        text: 'Reply from Account A',
      }),
    ]);
    const dispatch = harness.connection.prepare(`
      SELECT account_id, reply_template_id, source_message_id, status, reply_message_id,
        reply_message_link
      FROM automation_dispatches WHERE source_message_id = 103
    `).get();
    expect(dispatch).toEqual({
      account_id: 1,
      reply_template_id: 1,
      source_message_id: 103,
      status: 'sent',
      reply_message_id: 5001,
      reply_message_link: 'https://t.me/c/900/5001',
    });
    expect(harness.notifier.notifications).toContainEqual({
      accountKey: ACCOUNT_A,
      notification: {
        type: 'reply_sent',
        accountNickname: 'Account A',
        channelTitle: 'Channel One',
        trigger: 'bucin',
        sourceMessageId: 103,
        sourceMessageLink: 'https://t.me/channel_one/103',
        reactionStatus: 'skipped',
        reactionReason: 'auto_reaction_disabled',
      },
    });
    expect(harness.eventTypes()).toEqual(expect.arrayContaining([
      'detection_matched',
      'reply_scheduled',
      'reply_sent',
      'duplicate_skipped',
      'account_notified',
    ]));
    harness.close();
  });

  it('cleanup sender match blocks every assignment for that channel but leaves others active', async () => {
    const harness = createHarness();
    await harness.listeners.startAll(OWNER);
    harness.connection.prepare(`
      INSERT INTO automation_dispatches (
        account_id, channel_id, reply_template_id, source_message_id,
        matched_trigger, delay_ms, status
      ) VALUES (1, 1, 1, 109, 'bucin', 600000, 'scheduled')
    `).run();
    expect(harness.listeners.isActive(1)).toBe(true);
    expect(harness.listeners.isActive(2)).toBe(false);
    expect(harness.listeners.isActive(3)).toBe(true);

    await harness.process(1, 1, {
      text: 'bucin',
      senderDisplayName: '‼️ JGN   REPLY ‼️',
      sourceMessageId: 110,
    });
    expect(harness.channels.getForOwner(OWNER, 1)?.automationBlocked).toBe(true);
    expect(harness.listeners.isActive(1)).toBe(false);
    expect(harness.listeners.isActive(2)).toBe(false);
    expect(harness.listeners.isActive(3)).toBe(true);
    expect(harness.telegram.sends).toHaveLength(0);
    expect(harness.connection.prepare(`
      SELECT status, error_reason FROM automation_dispatches WHERE source_message_id = 109
    `).get()).toEqual({ status: 'limit_skipped', error_reason: 'channel_cleanup_blocked' });
    expect(harness.safetyNotifier.notifications).toContainEqual({
      type: 'cleanup_blocked',
      channelTitle: 'Channel One',
      pattern: 'jgn reply',
    });
    expect(harness.eventTypes()).toEqual(expect.arrayContaining([
      'cleanup_detected',
      'channel_blocked',
    ]));
    await harness.safety.resumeChannel(1);
    expect(harness.channels.getForOwner(OWNER, 1)?.automationBlocked).toBe(false);
    expect(harness.listeners.isActive(1)).toBe(true);
    expect(harness.listeners.isActive(2)).toBe(false);
    harness.close();
  });

  it('does not block a channel when no resolved sender name matches cleanup', async () => {
    const harness = createHarness();
    await harness.process(1, 1, {
      text: 'bucin',
      senderDisplayNames: [
        { source: 'post_author', value: 'Regular Seller' },
        { source: 'channel_title_fallback', value: 'Channel One' },
      ],
      sourceMessageId: 111,
    });
    expect(harness.channels.getForOwner(OWNER, 1)?.automationBlocked).toBe(false);
    expect(harness.telegram.sends).toHaveLength(1);
    harness.close();
  });

  it('keeps a successful reply sent when link generation is unavailable', async () => {
    const harness = createHarness();
    harness.telegram.linkMode = 'unavailable';
    harness.settings.setAutoReaction(ACCOUNT_A, true);
    await harness.process(1, 1, { text: 'bucin', sourceMessageId: 115 });

    expect(harness.connection.prepare(`
      SELECT status, reply_message_id, reply_message_link, reaction_status
      FROM automation_dispatches WHERE source_message_id = 115
    `).get()).toEqual({
      status: 'sent',
      reply_message_id: 5001,
      reply_message_link: null,
      reaction_status: 'sent',
    });
    expect(harness.telegram.reactions).toEqual([{
      accountKey: ACCOUNT_A,
      channelIdentifier: '@channel_one',
      replyMessageId: 5001,
    }]);
    expect(harness.notifier.notifications).toContainEqual({
      accountKey: ACCOUNT_A,
      notification: {
        type: 'reply_sent',
        accountNickname: 'Account A',
        channelTitle: 'Channel One',
        trigger: 'bucin',
        sourceMessageId: 115,
        sourceMessageLink: 'https://t.me/channel_one/115',
        reactionStatus: 'sent',
      },
    });
    expect(harness.eventTypes()).toContain('reply_link_unavailable');
    expect(harness.eventTypes()).not.toContain('reply_failed');
    harness.close();
  });

  it('reacts every eligible account to the original source post independently', async () => {
    const harness = createHarness();
    harness.connection.prepare('UPDATE account_channels SET is_enabled = 1 WHERE id IN (2, 4)').run();
    harness.settings.setAutoReaction(ACCOUNT_A, true);
    harness.settings.setAutoReaction(ACCOUNT_B, true);
    harness.settings.setAutoReaction(ACCOUNT_C, true);
    harness.telegram.nextReplyMessageId = 24;

    await harness.process(1, 1, { text: 'bucin', sourceMessageId: 117 });

    expect(harness.telegram.reactions).toEqual([
      { accountKey: ACCOUNT_A, channelIdentifier: '@channel_one', replyMessageId: 24 },
      { accountKey: ACCOUNT_B, channelIdentifier: '@channel_one', replyMessageId: 25 },
      { accountKey: ACCOUNT_C, channelIdentifier: '@channel_one', replyMessageId: 26 },
    ]);
    expect(harness.connection.prepare(`
      SELECT source_message_id, reply_message_id, reaction_status
      FROM automation_dispatches WHERE source_message_id = 117 ORDER BY account_id
    `).all()).toEqual([
      { source_message_id: 117, reply_message_id: 24, reaction_status: 'sent' },
      { source_message_id: 117, reply_message_id: 25, reaction_status: 'sent' },
      { source_message_id: 117, reply_message_id: 26, reaction_status: 'sent' },
    ]);
    harness.close();
  });

  it('uses a private source-post link and keeps reply success if notification fails', async () => {
    const harness = createHarness();
    harness.connection.prepare('UPDATE channels SET username = NULL WHERE id = 2').run();
    harness.notifier.mode = 'failed';

    await expect(harness.process(3, 2, { text: 'bucin', sourceMessageId: 116 }))
      .resolves.toBeUndefined();

    expect(harness.notifier.notifications).toContainEqual({
      accountKey: ACCOUNT_B,
      notification: {
        type: 'reply_sent',
        accountNickname: 'Account B',
        channelTitle: 'Channel Two',
        trigger: 'bucin',
        sourceMessageId: 116,
        sourceMessageLink: 'https://t.me/c/900002/116',
        reactionStatus: 'skipped',
        reactionReason: 'auto_reaction_disabled',
      },
    });
    expect(harness.connection.prepare(`
      SELECT status, reply_message_id FROM automation_dispatches WHERE source_message_id = 116
    `).get()).toEqual({ status: 'sent', reply_message_id: 5001 });
    expect(harness.connection.prepare(`
      SELECT status, error_reason FROM logs
      WHERE event_type = 'account_notified' AND json_extract(metadata, '$.sourceMessageId') = 116
    `).get()).toEqual({ status: 'failed', error_reason: 'NOTIFICATION_FAILED' });
    harness.close();
  });

  it('validates and stores zero, decimal, and 600-second custom delays', () => {
    const harness = createHarness();
    expect(parseSecondsToMilliseconds('0', 'Reply delay', 600)).toBe(0);
    expect(parseSecondsToMilliseconds('0.01', 'Reply delay', 600)).toBe(10);
    expect(parseSecondsToMilliseconds('0.5', 'Reply delay', 600)).toBe(500);
    expect(parseSecondsToMilliseconds('7.25', 'Reply delay', 600)).toBe(7_250);
    expect(parseSecondsToMilliseconds('600', 'Reply delay', 600)).toBe(600_000);
    expect(() => parseSecondsToMilliseconds('-1', 'Reply delay', 600)).toThrow(/non-negative/i);
    expect(() => parseSecondsToMilliseconds('600.01', 'Reply delay', 600)).toThrow(/exceed/i);
    expect(harness.settings.setReplyDelay(ACCOUNT_A, '0.01').replyDelayMs).toBe(10);
    expect(harness.settings.setReplyDelay(ACCOUNT_B, '600').replyDelayMs).toBe(600_000);
    harness.close();
  });

  it('applies account-owned delay/template and isolates settings between accounts', async () => {
    const harness = createHarness();
    harness.settings.setReplyDelay(ACCOUNT_A, '7.25');
    harness.settings.setReplyDelay(ACCOUNT_B, '0.5');
    await harness.process(1, 1, { text: 'bucin', sourceMessageId: 120 });
    await harness.process(3, 2, { text: 'bucin', sourceMessageId: 121 });
    expect((harness.scheduler as ImmediateScheduler).waits).toEqual([7_250, 500]);
    expect(harness.telegram.sends.map((send) => [send.accountKey, send.text])).toEqual([
      [ACCOUNT_A, 'Reply from Account A'],
      [ACCOUNT_B, 'Reply from Account B'],
    ]);
    expect(harness.notifier.notifications).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountKey: ACCOUNT_A }),
      expect.objectContaining({ accountKey: ACCOUNT_B }),
    ]));
    harness.close();
  });

  it('does not attempt a reaction when Auto Reaction is off', async () => {
    const harness = createHarness();
    await harness.process(1, 1, { text: 'bucin', sourceMessageId: 129 });
    expect(harness.telegram.reactions).toHaveLength(0);
    expect(harness.connection.prepare(`
      SELECT status, reaction_status, error_reason FROM automation_dispatches
      WHERE source_message_id = 129
    `).get()).toEqual({
      status: 'sent',
      reaction_status: 'skipped',
      error_reason: 'auto_reaction_disabled',
    });
    harness.close();
  });

  it('records reaction sent, unsupported, and failed without changing reply success', async () => {
    const harness = createHarness();
    harness.settings.setAutoReaction(ACCOUNT_A, true);
    harness.settings.setAutoReaction(ACCOUNT_B, true);
    harness.settings.setAutoReaction(ACCOUNT_C, true);
    await harness.process(1, 1, { text: 'bucin', sourceMessageId: 130 });
    harness.telegram.reactionMode = 'skipped';
    await harness.process(1, 1, { text: 'bucin', sourceMessageId: 131 });
    harness.telegram.reactionMode = 'failed';
    await harness.process(1, 1, { text: 'bucin', sourceMessageId: 132 });
    expect(harness.connection.prepare(`
      SELECT source_message_id, status, reaction_status FROM automation_dispatches
      WHERE source_message_id BETWEEN 130 AND 132 ORDER BY source_message_id
    `).all()).toEqual([
      { source_message_id: 130, status: 'sent', reaction_status: 'sent' },
      { source_message_id: 131, status: 'sent', reaction_status: 'skipped' },
      { source_message_id: 132, status: 'sent', reaction_status: 'failed' },
    ]);
    expect(harness.eventTypes()).toEqual(expect.arrayContaining([
      'reaction_sent',
      'reaction_skipped',
      'reaction_failed',
    ]));
    harness.close();
  });

  it('enforces cooldown, hourly limit, and daily limit without crashing', async () => {
    const cooldown = createHarness();
    cooldown.telegram.unavailable.add(ACCOUNT_B);
    cooldown.telegram.unavailable.add(ACCOUNT_C);
    cooldown.settings.setCooldown(ACCOUNT_A, '60');
    await cooldown.process(1, 1, { text: 'bucin', sourceMessageId: 140 });
    await cooldown.process(1, 1, { text: 'bucin', sourceMessageId: 141 });
    expect(cooldown.telegram.sends).toHaveLength(1);
    expect(cooldown.eventTypes()).toContain('cooldown_skipped');
    cooldown.close();

    const hourly = createHarness();
    hourly.telegram.unavailable.add(ACCOUNT_B);
    hourly.telegram.unavailable.add(ACCOUNT_C);
    hourly.settings.setHourlyLimit(ACCOUNT_A, '1');
    await hourly.process(1, 1, { text: 'bucin', sourceMessageId: 142 });
    await hourly.process(1, 1, { text: 'bucin', sourceMessageId: 143 });
    expect(hourly.telegram.sends).toHaveLength(1);
    expect(hourly.connection.prepare(`
      SELECT error_reason FROM automation_dispatches WHERE source_message_id = 143
    `).get()).toEqual({ error_reason: 'hourly_limit_reached' });
    hourly.close();

    const daily = createHarness();
    daily.telegram.unavailable.add(ACCOUNT_B);
    daily.telegram.unavailable.add(ACCOUNT_C);
    daily.settings.setDailyLimit(ACCOUNT_A, '1');
    await daily.process(1, 1, { text: 'bucin', sourceMessageId: 144 });
    await daily.process(1, 1, { text: 'bucin', sourceMessageId: 145 });
    expect(daily.telegram.sends).toHaveLength(1);
    expect(daily.connection.prepare(`
      SELECT error_reason FROM automation_dispatches WHERE source_message_id = 145
    `).get()).toEqual({ error_reason: 'daily_limit_reached' });
    daily.close();
  });

  it('persists duplicate protection across a reconstructed processor/reconnect', async () => {
    const harness = createHarness();
    await harness.process(1, 1, { text: 'bucin', sourceMessageId: 150 });
    const reconstructed = harness.createProcessor();
    await reconstructed.process(harness.input(2, 1, { text: 'bucin', sourceMessageId: 150 }));
    expect(harness.telegram.sends).toHaveLength(1);
    expect(harness.eventTypes()).toContain('duplicate_skipped');
    harness.close();
  });

  it('dispatches one source message to all three eligible assigned accounts', async () => {
    const harness = createHarness();
    harness.connection.prepare('UPDATE account_channels SET is_enabled = 1 WHERE id IN (2, 4)').run();
    await harness.process(1, 1, { text: 'bucin', sourceMessageId: 190 });
    expect(harness.telegram.sends.map((send) => send.accountKey)).toEqual([
      ACCOUNT_A, ACCOUNT_B, ACCOUNT_C,
    ]);
    expect(harness.connection.prepare(`
      SELECT account_id FROM automation_dispatches
      WHERE channel_id = 1 AND source_message_id = 190 ORDER BY account_id
    `).all()).toEqual([{ account_id: 1 }, { account_id: 2 }, { account_id: 3 }]);
    harness.close();
  });

  it('dispatches to two eligible accounts and excludes an offline account without blocking others', async () => {
    const harness = createHarness();
    harness.connection.prepare('UPDATE account_channels SET is_enabled = 1 WHERE id = 2').run();
    await harness.process(1, 1, { text: 'bucin', sourceMessageId: 200 });
    expect(harness.telegram.sends.map((send) => send.accountKey)).toEqual([
      ACCOUNT_A, ACCOUNT_B,
    ]);
    harness.close();

    const offline = createHarness();
    offline.connection.prepare('UPDATE account_channels SET is_enabled = 1 WHERE id IN (2, 4)').run();
    offline.telegram.unavailable.add(ACCOUNT_B);
    await offline.process(1, 1, { text: 'bucin', sourceMessageId: 201 });
    expect(offline.telegram.sends.map((send) => send.accountKey)).toEqual([ACCOUNT_A, ACCOUNT_C]);
    offline.close();
  });

  it('does not repeat an account dispatch when the same source message is delivered twice', async () => {
    const harness = createHarness();
    harness.connection.prepare('UPDATE account_channels SET is_enabled = 1 WHERE id IN (2, 4)').run();
    await harness.process(1, 1, { text: 'bucin', sourceMessageId: 204 });
    await harness.process(2, 1, { text: 'bucin', sourceMessageId: 204 });
    expect(harness.telegram.sends.map((send) => send.accountKey)).toEqual([
      ACCOUNT_A, ACCOUNT_B, ACCOUNT_C,
    ]);
    expect(harness.connection.prepare(`
      SELECT COUNT(*) AS count FROM automation_dispatches
      WHERE channel_id = 1 AND source_message_id = 204
    `).get()).toEqual({ count: 3 });
    expect(harness.eventTypes()).toContain('duplicate_skipped');
    harness.close();
  });

  it('does not dispatch when no eligible account is connected', async () => {
    const noneAvailable = createHarness();
    noneAvailable.telegram.unavailable.add(ACCOUNT_A);
    noneAvailable.telegram.unavailable.add(ACCOUNT_B);
    noneAvailable.telegram.unavailable.add(ACCOUNT_C);
    await noneAvailable.process(1, 1, { text: 'bucin', sourceMessageId: 206 });
    expect(noneAvailable.telegram.sends).toHaveLength(0);
    expect(noneAvailable.connection.prepare(`
      SELECT COUNT(*) AS count FROM automation_dispatches WHERE source_message_id = 206
    `).get()).toEqual({ count: 0 });
    noneAvailable.close();
  });

  it('keeps per-account duplicate claims atomic across concurrent listeners', async () => {
    const harness = createHarness();
    harness.connection.prepare('UPDATE account_channels SET is_enabled = 1 WHERE id IN (2, 4)').run();
    await Promise.all([
      harness.process(1, 1, { text: 'bucin', sourceMessageId: 210 }),
      harness.process(2, 1, { text: 'bucin', sourceMessageId: 210 }),
      harness.process(4, 1, { text: 'bucin', sourceMessageId: 210 }),
    ]);
    expect(harness.telegram.sends).toHaveLength(3);
    expect(harness.connection.prepare(`
      SELECT COUNT(*) AS count FROM automation_dispatches
      WHERE channel_id = 1 AND source_message_id = 210
    `).get()).toEqual({ count: 3 });
    expect(harness.eventTypes()).toContain('duplicate_skipped');
    harness.close();
  });

  it('skips disabled or template-less accounts and does not dispatch for a blocked channel', async () => {
    const disabled = createHarness();
    disabled.connection.prepare('UPDATE account_channels SET is_enabled = 1 WHERE id IN (2, 4)').run();
    disabled.connection.prepare('UPDATE accounts SET is_enabled = 0 WHERE id = 2').run();
    await disabled.process(1, 1, { text: 'bucin', sourceMessageId: 220 });
    await disabled.process(1, 1, { text: 'bucin', sourceMessageId: 221 });
    expect(disabled.telegram.sends.map((send) => send.accountKey)).toEqual([
      ACCOUNT_A, ACCOUNT_C, ACCOUNT_A, ACCOUNT_C,
    ]);
    disabled.close();

    const noTemplate = createHarness();
    noTemplate.connection.prepare('UPDATE account_channels SET is_enabled = 1 WHERE id IN (2, 4)').run();
    noTemplate.connection.prepare('UPDATE reply_templates SET is_enabled = 0 WHERE account_id = 2').run();
    await noTemplate.process(1, 1, { text: 'bucin', sourceMessageId: 222 });
    await noTemplate.process(1, 1, { text: 'bucin', sourceMessageId: 223 });
    expect(noTemplate.telegram.sends.map((send) => send.accountKey)).toEqual([
      ACCOUNT_A, ACCOUNT_C, ACCOUNT_A, ACCOUNT_C,
    ]);
    noTemplate.close();

    const blocked = createHarness();
    blocked.channels.setAutomationBlocked(1, true, 'test');
    await blocked.process(1, 1, { text: 'bucin', sourceMessageId: 224 });
    expect(blocked.telegram.sends).toHaveLength(0);
    expect(blocked.connection.prepare(`
      SELECT COUNT(*) AS count FROM automation_dispatches WHERE source_message_id = 224
    `).get()).toEqual({ count: 0 });
    blocked.close();
  });

  it('STOP ALL and RESUME ALL persist and restart only eligible listeners', async () => {
    const harness = createHarness();
    await harness.listeners.startAll(OWNER);
    harness.connection.prepare(`
      INSERT INTO automation_dispatches (
        account_id, channel_id, reply_template_id, source_message_id,
        matched_trigger, delay_ms, status
      ) VALUES (1, 1, 1, 159, 'bucin', 600000, 'scheduled')
    `).run();
    await harness.safety.stopAll();
    expect(harness.safety.getStatus()).toEqual({ enabled: false });
    expect(harness.listeners.isActive(1)).toBe(false);
    expect(harness.connection.prepare(`
      SELECT status, error_reason FROM automation_dispatches WHERE source_message_id = 159
    `).get()).toEqual({ status: 'limit_skipped', error_reason: 'global_stop_all' });
    await harness.process(1, 1, { text: 'bucin', sourceMessageId: 160 });
    expect(harness.telegram.sends).toHaveLength(0);

    await harness.safety.resumeAll();
    expect(harness.safety.getStatus()).toEqual({ enabled: true });
    expect(harness.listeners.isActive(1)).toBe(true);
    await harness.process(1, 1, { text: 'bucin', sourceMessageId: 161 });
    expect(harness.telegram.sends).toHaveLength(1);
    harness.close();
  });

  it('isolates reply errors by account and channel', async () => {
    const harness = createHarness();
    harness.telegram.failureReasons.set(ACCOUNT_A, 'FLOOD_WAIT_30');
    await expect(harness.process(1, 1, { text: 'bucin', sourceMessageId: 170 }))
      .resolves.toBeUndefined();
    await expect(harness.process(3, 2, { text: 'bucin', sourceMessageId: 171 }))
      .resolves.toBeUndefined();
    expect(harness.connection.prepare(`
      SELECT source_message_id, status FROM automation_dispatches
      WHERE source_message_id IN (170, 171) ORDER BY source_message_id
    `).all()).toEqual([
      { source_message_id: 170, status: 'failed' },
      { source_message_id: 171, status: 'sent' },
    ]);
    expect(harness.notifier.notifications.some(({ accountKey, notification }) =>
      accountKey === ACCOUNT_A && notification.type === 'reply_failed')).toBe(true);
    expect(harness.notifier.notifications.some(({ accountKey, notification }) =>
      accountKey === ACCOUNT_B && notification.type === 'reply_sent')).toBe(true);
    expect(harness.eventTypes()).toContain('flood_wait');
    harness.close();
  });

  it('cancels and drains a pending delayed reply before storage/logger shutdown', async () => {
    const scheduler = new BlockingScheduler();
    const harness = createHarness(scheduler);
    harness.settings.setReplyDelay(ACCOUNT_A, '600');
    const processing = harness.process(1, 1, { text: 'bucin', sourceMessageId: 180 });
    await scheduler.started;

    await expect(harness.processor.shutdown()).resolves.toBeUndefined();
    await expect(processing).resolves.toBeUndefined();
    expect(harness.telegram.sends).toHaveLength(0);
    expect(harness.connection.prepare(`
      SELECT status, error_reason FROM automation_dispatches WHERE source_message_id = 180
    `).get()).toEqual({ status: 'limit_skipped', error_reason: 'application_shutdown' });
    harness.close();
  });
});

function createHarness(scheduler: DelayScheduler = new ImmediateScheduler()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-wtb-m5-'));
  const logger = createLogger({
    level: 'error',
    logDirectory: path.join(root, 'logs'),
    environment: 'test',
    writeToStdout: false,
  });
  const database = new DatabaseService(path.join(root, 'db.sqlite'), logger.logger);
  database.initialize();
  database.ensureOwner(OWNER);
  const connection = database.getConnection();
  connection.exec(`
    INSERT INTO accounts (
      id, owner_id, label, session_key, phone_number, status, is_enabled
    ) VALUES
      (1, 1, 'Account A', '${ACCOUNT_A}', '+628111111111', 'connected', 1),
      (2, 1, 'Account B', '${ACCOUNT_B}', '+628222222222', 'connected', 1),
      (3, 1, 'Account C', '${ACCOUNT_C}', '+628333333333', 'connected', 1);
    INSERT INTO channels (id, telegram_channel_id, username, title, is_enabled) VALUES
      (1, '900001', 'channel_one', 'Channel One', 1),
      (2, '900002', 'channel_two', 'Channel Two', 1);
    INSERT INTO account_channels (id, account_id, channel_id, is_enabled, status) VALUES
      (1, 1, 1, 1, 'healthy'),
      (2, 2, 1, 0, 'healthy'),
      (3, 2, 2, 1, 'healthy'),
      (4, 3, 1, 0, 'healthy');
  `);

  const accounts = new AccountService(
    new AccountRepository(connection),
    OWNER,
    logger.logger,
  );
  const channels = new ChannelRepository(connection);
  const eventLogs = new EventLogRepository(connection);
  const listenerGateway = new FakeListenerGateway();
  const listeners = new ChannelListenerService(channels, listenerGateway, logger.logger);
  const channelService = new ChannelService(
    channels,
    accounts,
    OWNER,
    listenerGateway,
    listeners,
    logger.logger,
  );
  const safety = new AutomationSafetyService(
    connection,
    channelService,
    eventLogs,
    logger.logger,
  );
  const templates = new ReplyTemplateService(
    new ReplyTemplateRepository(connection),
    OWNER,
    logger.logger,
  );
  templates.create(ACCOUNT_A, 'Template A', 'Reply from Account A');
  templates.create(ACCOUNT_B, 'Template B', 'Reply from Account B');
  templates.create(ACCOUNT_C, 'Template C', 'Reply from Account C');
  const settings = new AccountAutomationSettingsService(
    new AccountAutomationSettingsRepository(connection),
    OWNER,
    logger.logger,
  );
  const keywords = new GlobalKeywordService(connection, logger.logger);
  keywords.setTriggerKeywords('bucin, mensive');
  keywords.setExcludeKeywords('fmv, channel');
  keywords.setCleanupPatterns('JGN REPLY');
  const rules = new RuleRepository(connection);
  const detection = new DetectionPipelineService(
    new GlobalDetectionService(keywords, eventLogs, logger.logger),
    new DetectionService(rules, eventLogs, logger.logger),
  );
  const telegram = new FakeAutoReplyGateway();
  const notifier = new FakeNotifier();
  const safetyNotifier = new FakeSafetyNotifier();
  const dispatches = new AutomationDispatchRepository(connection);

  const createProcessor = () => new AutoReplyService(
    detection,
    safety,
    channels,
    rules,
    templates,
    settings,
    dispatches,
    telegram,
    notifier,
    safetyNotifier,
    eventLogs,
    OWNER,
    logger.logger,
    scheduler,
  );
  const processor = createProcessor();
  listeners.setProcessor(processor);

  const input = (
    assignmentId: number,
    channelId: number,
    message: Partial<TelegramIncomingMessage> & { text: string },
  ) => {
    const detail = channelService.getChannel(channelId);
    const assignment = detail.assignments.find((item) => item.id === assignmentId);
    if (assignment === undefined) throw new Error('Test assignment not found');
    return {
      assignment,
      channel: detail.channel,
      message: {
        chatKind: 'channel_post' as const,
        telegramChannelId: detail.channel.telegramChannelId,
        ...message,
      },
    };
  };

  return {
    database,
    connection,
    logger,
    channels,
    listeners,
    safety,
    settings,
    telegram,
    notifier,
    safetyNotifier,
    scheduler,
    processor,
    input,
    createProcessor,
    process(
      assignmentId: number,
      channelId: number,
      message: Partial<TelegramIncomingMessage> & { text: string },
    ) {
      return processor.process(input(assignmentId, channelId, message));
    },
    eventTypes(): string[] {
      return connection.prepare('SELECT event_type FROM logs ORDER BY id').all()
        .map((row) => (row as { event_type: string }).event_type);
    },
    close() {
      database.close();
      logger.close();
    },
  };
}
