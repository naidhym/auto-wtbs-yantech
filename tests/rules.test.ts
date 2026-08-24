import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import type { ChannelAssignmentRecord, ChannelRecord } from '../src/channels/channel.types.js';
import { DatabaseService } from '../src/database/database.service.js';
import { EventLogRepository } from '../src/logging/event-log.repository.js';
import { createLogger, type LoggerHandle } from '../src/logging/logger.js';
import {
  GlobalDetectionService,
  normalizeGlobalMatchText,
} from '../src/rules/global-detection.service.js';
import {
  GlobalKeywordService,
  parseCommaSeparatedKeywords,
} from '../src/rules/global-keyword.service.js';
import type { TelegramChatKind } from '../src/rules/rule.types.js';

const OWNER = '123456789';
const ACCOUNT_KEY = 'account-00000000-0000-4000-8000-000000000901';

describe('M4 global keywords and channel-only detection', () => {
  it('normalizes comma-separated keywords and persists the global configuration', () => {
    const harness = createHarness();
    expect(parseCommaSeparatedKeywords(' Bucin, mensive, , BULOL, bucin '))
      .toEqual(['bucin', 'mensive', 'bulol']);

    harness.keywords.setTriggerKeywords(' Bucin, mensive, , BULOL, bucin ');
    harness.keywords.setExcludeKeywords(' FMV, channel, ch, ');
    harness.keywords.setCleanupPatterns(' JGN REPLY, no reply, ');
    expect(harness.keywords.getConfiguration()).toEqual({
      triggerKeywords: ['bucin', 'mensive', 'bulol'],
      excludeKeywords: ['fmv', 'channel', 'ch'],
      cleanupPatterns: ['jgn reply', 'no reply'],
      enabled: true,
    });

    const restored = new GlobalKeywordService(harness.connection, harness.logger.logger);
    expect(restored.getConfiguration()).toEqual(harness.keywords.getConfiguration());
    harness.close();
  });

  it('matches any trigger case-insensitively after basic text normalization', () => {
    const harness = createHarness();
    harness.keywords.setTriggerKeywords('bucin, mensive');
    harness.keywords.setExcludeKeywords('fmv');

    expect(harness.detect('channel_post', 'Open WTB: BUCIN‼️ hari ini'))
      .toEqual({ type: 'MATCH', matchedTrigger: 'bucin' });
    expect(normalizeGlobalMatchText('  BUCIN‼️  ')).toBe('bucin');

    const row = harness.connection.prepare(`
      SELECT account_id, channel_id, error_reason, metadata
      FROM logs WHERE event_type = 'detection_match'
    `).get() as { account_id: number; channel_id: number; error_reason: string; metadata: string };
    expect(row).toMatchObject({
      account_id: 1,
      channel_id: 1,
      error_reason: 'trigger_keyword:bucin',
    });
    expect(JSON.parse(row.metadata)).toEqual({ matchedTrigger: 'bucin' });
    harness.close();
  });

  it('lets any exclude win globally, even when no trigger is present', () => {
    const harness = createHarness();
    harness.keywords.setTriggerKeywords('bucin');
    harness.keywords.setExcludeKeywords('fmv, channel');

    expect(harness.detect('channel_post', 'bucin bonus FMV'))
      .toEqual({ type: 'EXCLUDED', matchedExclude: 'fmv' });
    expect(harness.detect('channel_post', 'new CHANNEL update'))
      .toEqual({ type: 'EXCLUDED', matchedExclude: 'channel' });

    const rows = harness.connection.prepare(`
      SELECT account_id, channel_id, error_reason, exclude_keyword, metadata
      FROM logs WHERE event_type = 'detection_excluded' ORDER BY id
    `).all() as Array<{
      account_id: number;
      channel_id: number;
      error_reason: string;
      exclude_keyword: string;
      metadata: string;
    }>;
    expect(rows[0]).toMatchObject({
      account_id: 1,
      channel_id: 1,
      error_reason: 'exclude_keyword:fmv',
      exclude_keyword: 'fmv',
    });
    expect(JSON.parse(rows[1]!.metadata)).toEqual({ matchedExclude: 'channel' });
    harness.close();
  });

  it('ignores channel posts when no trigger or exclude matches', () => {
    const harness = createHarness();
    harness.keywords.setTriggerKeywords('bucin');
    harness.keywords.setExcludeKeywords('fmv');
    expect(harness.detect('channel_post', 'ordinary marketplace post')).toBeUndefined();
    expect(harness.connection.prepare(`
      SELECT COUNT(*) AS count FROM logs
      WHERE event_type IN ('detection_match', 'detection_excluded')
    `).get()).toEqual({ count: 0 });
    harness.close();
  });

  it('matches cleanup against sender display name and honors global enable/disable', () => {
    const harness = createHarness();
    harness.keywords.setTriggerKeywords('bucin');
    harness.keywords.setCleanupPatterns('JGN REPLY');
    const input = {
      assignment: harness.assignment,
      channel: harness.channel,
      message: {
        chatKind: 'channel_post' as const,
        telegramChannelId: harness.channel.telegramChannelId,
        text: 'ordinary post',
        senderDisplayName: '‼️ JGN REPLY ‼️',
      },
    };
    expect(harness.detector.process(input)).toEqual({
      type: 'CLEANUP_MATCH',
      matchedCleanup: 'jgn reply',
    });
    expect(harness.connection.prepare(`
      SELECT account_id, channel_id, error_reason, metadata
      FROM logs WHERE event_type = 'cleanup_match'
    `).get()).toEqual(expect.objectContaining({
      account_id: 1,
      channel_id: 1,
      error_reason: 'sender_display_name_pattern:jgn reply',
    }));

    harness.keywords.setEnabled(false);
    expect(harness.detector.process({
      ...input,
      message: { ...input.message, text: 'bucin', senderDisplayName: 'Seller' },
    })).toBeUndefined();
    harness.close();
  });

  it.each([
    'JGN REPLY',
    '‼️ JGN REPLY ‼️',
    'JGN  REPLY',
    'jGn RePlY',
  ])('matches normalized cleanup sender candidate %s', (senderName) => {
    const harness = createHarness();
    harness.keywords.setCleanupPatterns('JGN REPLY');
    expect(harness.detector.process({
      assignment: harness.assignment,
      channel: harness.channel,
      message: {
        chatKind: 'channel_post',
        telegramChannelId: harness.channel.telegramChannelId,
        text: 'ordinary post',
        senderDisplayName: 'Unrelated Post Author',
        senderDisplayNames: [
          { source: 'post_author', value: 'Unrelated Post Author' },
          { source: 'from_id_sender', value: senderName },
          { source: 'channel_title_fallback', value: harness.channel.title },
        ],
      },
    })).toEqual({ type: 'CLEANUP_MATCH', matchedCleanup: 'jgn reply' });
    harness.close();
  });

  it('does not emit cleanup when no resolved sender candidate matches', () => {
    const harness = createHarness();
    harness.keywords.setCleanupPatterns('JGN REPLY');
    expect(harness.detector.process({
      assignment: harness.assignment,
      channel: harness.channel,
      message: {
        chatKind: 'channel_post',
        telegramChannelId: harness.channel.telegramChannelId,
        text: 'ordinary post',
        senderDisplayNames: [
          { source: 'post_author', value: 'Regular Seller' },
          { source: 'channel_title_fallback', value: harness.channel.title },
        ],
      },
    })).toBeUndefined();
    harness.close();
  });

  it.each<TelegramChatKind>(['group', 'supergroup', 'discussion', 'private', 'unknown'])(
    'ignores %s even when global keywords match',
    (chatKind) => {
      const harness = createHarness();
      harness.keywords.setTriggerKeywords('bucin');
      harness.keywords.setExcludeKeywords('fmv');
      expect(harness.detect(chatKind, 'bucin dan fmv')).toBeUndefined();
      expect(harness.connection.prepare(`
        SELECT event_type, error_reason, account_id, channel_id
        FROM logs WHERE event_type = 'non_channel_ignored'
      `).get()).toEqual({
        event_type: 'non_channel_ignored',
        error_reason: `chat_kind:${chatKind}`,
        account_id: 1,
        channel_id: 1,
      });
      expect(harness.connection.prepare(`
        SELECT COUNT(*) AS count FROM logs
        WHERE event_type IN ('detection_match', 'detection_excluded')
      `).get()).toEqual({ count: 0 });
      harness.close();
    },
  );

  it('ignores a channel post whose Telegram identity differs from the assigned channel', () => {
    const harness = createHarness();
    harness.keywords.setTriggerKeywords('bucin');
    expect(harness.detector.process({
      assignment: harness.assignment,
      channel: harness.channel,
      message: {
        chatKind: 'channel_post',
        telegramChannelId: 'different-channel',
        text: 'bucin',
      },
    })).toBeUndefined();
    expect(harness.connection.prepare(`
      SELECT error_reason FROM logs WHERE event_type = 'non_channel_ignored'
    `).get()).toEqual({ error_reason: 'channel_identity_mismatch' });
    harness.close();
  });
});

function createHarness(): {
  database: DatabaseService;
  connection: DatabaseSync;
  logger: LoggerHandle;
  keywords: GlobalKeywordService;
  detector: GlobalDetectionService;
  channel: ChannelRecord;
  assignment: ChannelAssignmentRecord;
  detect(chatKind: TelegramChatKind, text: string): ReturnType<GlobalDetectionService['process']>;
  close(): void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-wtb-global-rules-'));
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
    INSERT INTO accounts (id, owner_id, label, session_key, phone_number, status)
    VALUES (1, 1, 'Detection Account', '${ACCOUNT_KEY}', '+628111111111', 'connected');
    INSERT INTO channels (id, telegram_channel_id, username, title)
    VALUES (1, '100901', 'globaltest', 'Global Test Channel');
    INSERT INTO account_channels (id, account_id, channel_id, status)
    VALUES (1, 1, 1, 'active');
  `);

  const channel: ChannelRecord = {
    id: 1,
    telegramChannelId: '100901',
    username: 'globaltest',
    title: 'Global Test Channel',
    enabled: true,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const assignment: ChannelAssignmentRecord = {
    id: 1,
    accountId: 1,
    accountKey: ACCOUNT_KEY,
    accountNickname: 'Detection Account',
    channelId: 1,
    enabled: true,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const keywords = new GlobalKeywordService(connection, logger.logger);
  const detector = new GlobalDetectionService(
    keywords,
    new EventLogRepository(connection),
    logger.logger,
  );

  return {
    database,
    connection,
    logger,
    keywords,
    detector,
    channel,
    assignment,
    detect(chatKind, text) {
      return detector.process({
        assignment,
        channel,
        message: { chatKind, telegramChannelId: channel.telegramChannelId, text },
      });
    },
    close(): void {
      database.close();
      logger.close();
    },
  };
}
