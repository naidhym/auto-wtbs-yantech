import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ChannelAssignmentRecord, ChannelRecord } from '../src/channels/channel.types.js';
import { ChannelRepository } from '../src/channels/channel.repository.js';
import { DatabaseService } from '../src/database/database.service.js';
import { EventLogRepository } from '../src/logging/event-log.repository.js';
import { createLogger } from '../src/logging/logger.js';
import { DetectionService, normalizeMatchText } from '../src/rules/detection.service.js';
import { ReplyTemplateRepository } from '../src/rules/reply-template.repository.js';
import { ReplyTemplateService } from '../src/rules/reply-template.service.js';
import { RuleRepository } from '../src/rules/rule.repository.js';
import { RuleService } from '../src/rules/rule.service.js';
import type { TelegramChatKind } from '../src/rules/rule.types.js';

const OWNER = '123456789';
const OTHER_OWNER = '987654321';
const ACCOUNT_KEY = 'account-00000000-0000-4000-8000-000000000901';
const ACCOUNT_KEY_B = 'account-00000000-0000-4000-8000-000000000903';

describe('M4 rules, templates, and channel-only detection', () => {
  it('matches trigger case-insensitively and lets exclude win', () => {
    const harness = createHarness();
    const template = harness.templates.create(
      ACCOUNT_KEY,
      'WTB Reply',
      'Interested, please DM.',
    );
    const rule = harness.rules.create({
      name: 'Bucin WTB',
      channelId: harness.channel.id,
      triggerKeywords: ['BuCiN'],
      excludeKeywords: ['FMV'],
      cleanupSenderPatterns: ['JGN REPLY'],
      replyTemplateId: template.id,
    });
    harness.rules.setEnabled(rule.id, true);

    const match = harness.detect('channel_post', 'Open WTB BUCIN hari ini', 'Seller Name');
    expect(match).toEqual([expect.objectContaining({ type: 'MATCH', matchedValue: 'BuCiN' })]);

    const excluded = harness.detect('channel_post', 'bucin dengan bonus fMv', 'Seller Name');
    expect(excluded).toEqual([expect.objectContaining({ type: 'EXCLUDED', matchedValue: 'FMV' })]);
    expect(normalizeMatchText('  BUCIN‼️  ')).toBe('bucin');

    const rows = harness.connection.prepare(`
      SELECT event_type, account_id, channel_id, rule_id, error_reason, exclude_keyword
      FROM logs WHERE event_type IN ('detection_match', 'detection_excluded') ORDER BY id
    `).all();
    expect(rows).toEqual([
      expect.objectContaining({ event_type: 'detection_match', account_id: 1, channel_id: 1, rule_id: rule.id }),
      expect.objectContaining({ event_type: 'detection_excluded', error_reason: 'exclude_keyword:FMV', exclude_keyword: 'FMV' }),
    ]);
    harness.close();
  });

  it('matches cleanup against sender/display name only and emits no action', () => {
    const harness = createHarness();
    const rule = harness.createEnabledRule();
    expect(harness.detect('channel_post', 'ordinary post', '‼️ JGN REPLY ‼️'))
      .toEqual([expect.objectContaining({ type: 'CLEANUP_MATCH', ruleId: rule.id })]);
    expect(harness.detect('channel_post', 'text says JGN REPLY and bucin', 'Normal Seller'))
      .toEqual([expect.objectContaining({ type: 'MATCH' })]);
    expect(harness.connection.prepare(`
      SELECT event_type, error_reason FROM logs WHERE event_type = 'cleanup_match'
    `).get()).toEqual({ event_type: 'cleanup_match', error_reason: 'sender_display_name_pattern' });
    harness.close();
  });

  it('honors rule enable/disable and provides template CRUD', () => {
    const harness = createHarness();
    const template = harness.templates.create(ACCOUNT_KEY, 'First', 'Body one');
    expect(harness.templates.update(ACCOUNT_KEY, template.id, 'Updated', 'Body two').body)
      .toBe('Body two');
    expect(harness.templates.setEnabled(ACCOUNT_KEY, template.id, false).enabled).toBe(false);
    expect(harness.templates.setEnabled(ACCOUNT_KEY, template.id, true).enabled).toBe(true);

    const rule = harness.rules.create({
      name: 'Disabled Rule',
      channelId: harness.channel.id,
      triggerKeywords: ['bucin'],
      excludeKeywords: [],
      cleanupSenderPatterns: ['JGN REPLY'],
      replyTemplateId: template.id,
    });
    expect(harness.detect('channel_post', 'bucin', 'Seller')).toEqual([]);
    expect(harness.rules.setEnabled(rule.id, true).enabled).toBe(true);
    expect(harness.detect('channel_post', 'bucin', 'Seller')).toHaveLength(1);
    expect(harness.rules.setEnabled(rule.id, false).enabled).toBe(false);
    expect(harness.detect('channel_post', 'bucin', 'Seller')).toEqual([]);
    harness.templates.remove(ACCOUNT_KEY, template.id);
    expect(harness.rules.get(rule.id).replyTemplateId).toBeUndefined();
    harness.close();
  });

  it('isolates reply templates by account and validates rule/template assignment', () => {
    const harness = createHarness();
    harness.connection.prepare(`
      INSERT INTO accounts (id, owner_id, label, session_key, phone_number, is_enabled)
      VALUES (3, 1, 'Secondary', ?, '+628333333333', 1)
    `).run(ACCOUNT_KEY_B);
    const primary = harness.templates.create(ACCOUNT_KEY, 'Shared Name', 'Primary body');
    const secondary = harness.templates.create(ACCOUNT_KEY_B, 'Shared Name', 'Secondary body');

    expect(harness.templates.list(ACCOUNT_KEY)).toEqual([primary]);
    expect(harness.templates.list(ACCOUNT_KEY_B)).toEqual([secondary]);
    expect(() => harness.templates.get(ACCOUNT_KEY, secondary.id)).toThrow(/not found/i);
    expect(() => harness.templates.update(
      ACCOUNT_KEY,
      secondary.id,
      'Stolen',
      'No access',
    )).toThrow(/not found/i);
    expect(() => harness.rules.create({
      name: 'Wrong account template',
      channelId: 1,
      triggerKeywords: ['bucin'],
      excludeKeywords: [],
      cleanupSenderPatterns: [],
      replyTemplateId: secondary.id,
    })).toThrow(/template account is not assigned/i);

    harness.connection.prepare(`
      INSERT INTO account_channels (account_id, channel_id, is_enabled)
      VALUES (3, 1, 1)
    `).run();
    expect(harness.rules.create({
      name: 'Assigned account template',
      channelId: 1,
      triggerKeywords: ['bucin'],
      excludeKeywords: [],
      cleanupSenderPatterns: [],
      replyTemplateId: secondary.id,
    })).toEqual(expect.objectContaining({
      replyTemplateId: secondary.id,
      replyTemplateAccountKey: ACCOUNT_KEY_B,
    }));
    harness.close();
  });

  it('supports rule update/delete and records every management event with account/channel/reason', () => {
    const harness = createHarness();
    const created = harness.rules.create({
      name: 'Managed Rule',
      channelId: 1,
      triggerKeywords: ['bucin'],
      excludeKeywords: [],
      cleanupSenderPatterns: ['JGN REPLY'],
    });
    const updated = harness.rules.update(created.id, {
      name: 'Managed Rule Updated',
      channelId: 1,
      triggerKeywords: ['bucin', 'wtb'],
      excludeKeywords: ['fmv'],
      cleanupSenderPatterns: ['JGN REPLY'],
    });
    expect(updated.triggerKeywords).toEqual(['bucin', 'wtb']);
    harness.rules.setEnabled(created.id, true);
    harness.rules.setEnabled(created.id, false);
    harness.rules.remove(created.id);
    expect(harness.rules.list()).toEqual([]);

    const events = harness.connection.prepare(`
      SELECT event_type, account_id, channel_id, error_reason
      FROM logs WHERE event_type LIKE 'rule_%' ORDER BY id
    `).all();
    expect(events.map((row) => (row as { event_type: string }).event_type)).toEqual([
      'rule_created',
      'rule_updated',
      'rule_enabled',
      'rule_disabled',
      'rule_deleted',
    ]);
    for (const event of events) {
      const row = event as {
        account_id: number;
        channel_id: number;
        error_reason: string;
      };
      expect(row.account_id).toBe(1);
      expect(row.channel_id).toBe(1);
      expect(row.error_reason).toMatch(/^owner_/);
    }
    harness.close();
  });

  it.each<TelegramChatKind>(['group', 'supergroup', 'discussion', 'private', 'unknown'])(
    'ignores %s even when trigger and cleanup both match',
    (chatKind) => {
      const harness = createHarness();
      harness.createEnabledRule();
      expect(harness.detect(chatKind, 'BUCIN', '‼️ JGN REPLY ‼️')).toEqual([]);
      expect(harness.connection.prepare(`
        SELECT event_type, error_reason FROM logs WHERE event_type = 'non_channel_ignored'
      `).get()).toEqual({ event_type: 'non_channel_ignored', error_reason: `chat_kind:${chatKind}` });
      expect(harness.connection.prepare(`
        SELECT COUNT(*) AS count FROM logs
        WHERE event_type IN ('detection_match', 'detection_excluded', 'cleanup_match')
      `).get()).toEqual({ count: 0 });
      harness.close();
    },
  );

  it('ignores a channel post whose Telegram identity differs from the assignment channel', () => {
    const harness = createHarness();
    harness.createEnabledRule();
    expect(harness.detector.process({
      assignment: harness.assignment,
      channel: harness.channel,
      message: {
        chatKind: 'channel_post',
        telegramChannelId: 'different-channel',
        text: 'bucin',
        senderDisplayName: 'Seller',
      },
    })).toEqual([]);
    expect(harness.connection.prepare(`
      SELECT error_reason FROM logs WHERE event_type = 'non_channel_ignored'
    `).get()).toEqual({ error_reason: 'channel_identity_mismatch' });
    harness.close();
  });

  it('enforces Owner ownership for channels, templates, and rules', () => {
    const harness = createHarness();
    harness.connection.exec(`
      INSERT INTO owners (id, telegram_user_id) VALUES (2, '${OTHER_OWNER}');
      INSERT INTO accounts (id, owner_id, label, session_key, phone_number)
      VALUES (2, 2, 'Other', 'account-00000000-0000-4000-8000-000000000902', '+628222222222');
      INSERT INTO channels (id, telegram_channel_id, title) VALUES (2, '2002', 'Other Channel');
      INSERT INTO account_channels (account_id, channel_id) VALUES (2, 2);
      INSERT INTO reply_templates (id, account_id, name, body)
      VALUES (2, 2, 'Other Template', 'Secret');
    `);
    expect(() => harness.rules.create({
      name: 'Cross Owner Channel',
      channelId: 2,
      triggerKeywords: ['bucin'],
      excludeKeywords: [],
      cleanupSenderPatterns: [],
    })).toThrow(/not assigned.*Owner/i);
    expect(() => harness.rules.create({
      name: 'Cross Owner Template',
      channelId: 1,
      triggerKeywords: ['bucin'],
      excludeKeywords: [],
      cleanupSenderPatterns: [],
      replyTemplateId: 2,
    })).toThrow(/template not found/i);
    expect(harness.rules.list()).toHaveLength(0);
    harness.close();
  });
});

function createHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-wtb-rules-'));
  const logger = createLogger({ level: 'error', logDirectory: path.join(root, 'logs'), environment: 'test', writeToStdout: false });
  const database = new DatabaseService(path.join(root, 'db.sqlite'), logger.logger);
  database.initialize();
  database.ensureOwner(OWNER);
  const connection = database.getConnection();
  connection.exec(`
    INSERT INTO accounts (id, owner_id, label, session_key, phone_number, is_enabled)
    VALUES (1, 1, 'Primary', '${ACCOUNT_KEY}', '+628111111111', 1);
    INSERT INTO channels (id, telegram_channel_id, username, title, is_enabled)
    VALUES (1, '1001', 'market_channel', 'Market Channel', 1);
    INSERT INTO account_channels (id, account_id, channel_id, is_enabled)
    VALUES (1, 1, 1, 1);
  `);
  const channelRepository = new ChannelRepository(connection);
  const templateRepository = new ReplyTemplateRepository(connection);
  const eventLogs = new EventLogRepository(connection);
  const templates = new ReplyTemplateService(templateRepository, OWNER, logger.logger);
  const ruleRepository = new RuleRepository(connection);
  const rules = new RuleService(
    ruleRepository,
    channelRepository,
    templates,
    eventLogs,
    OWNER,
    logger.logger,
  );
  const detector = new DetectionService(ruleRepository, eventLogs, logger.logger);
  const channel: ChannelRecord = {
    id: 1,
    telegramChannelId: '1001',
    username: 'market_channel',
    title: 'Market Channel',
    enabled: true,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const assignment: ChannelAssignmentRecord = {
    id: 1,
    accountId: 1,
    accountKey: ACCOUNT_KEY,
    accountNickname: 'Primary',
    channelId: 1,
    enabled: true,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  return {
    database,
    connection,
    logger,
    templates,
    rules,
    detector,
    channel,
    assignment,
    createEnabledRule() {
      const rule = rules.create({
        name: 'Default Rule',
        channelId: 1,
        triggerKeywords: ['bucin'],
        excludeKeywords: ['fmv'],
        cleanupSenderPatterns: ['JGN REPLY'],
      });
      return rules.setEnabled(rule.id, true);
    },
    detect(chatKind: TelegramChatKind, text: string, senderDisplayName: string) {
      return detector.process({
        assignment,
        channel,
        message: { chatKind, telegramChannelId: '1001', text, senderDisplayName },
      });
    },
    close() {
      database.close();
      logger.close();
    },
  };
}
