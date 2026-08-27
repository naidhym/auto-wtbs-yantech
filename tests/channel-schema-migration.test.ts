import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { DatabaseService } from '../src/database/database.service.js';
import { createLogger } from '../src/logging/logger.js';

const CHANNEL_STATUSES = [
  'pending',
  'resolving',
  'syncing',
  'healthy',
  'degraded',
  'error',
  'disabled',
  'disconnected',
] as const;

function createPaths(prefix: string): {
  readonly runtimeDirectory: string;
  readonly databasePath: string;
  readonly logDirectory: string;
} {
  const runtimeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const databasePath = path.join(runtimeDirectory, 'data.sqlite');
  const logDirectory = path.join(runtimeDirectory, 'logs');
  return { runtimeDirectory, databasePath, logDirectory };
}

function countRows(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  return Number(row?.count ?? -1);
}

function createProductionShapedV12Database(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE owners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id TEXT NOT NULL UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL,
      label TEXT NOT NULL,
      telegram_user_id TEXT UNIQUE,
      session_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'disconnected',
      is_enabled INTEGER NOT NULL DEFAULT 0 CHECK (is_enabled IN (0, 1)),
      last_connected_at TEXT,
      phone_number TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE RESTRICT
    );

    CREATE TABLE channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_channel_id TEXT NOT NULL UNIQUE,
      username TEXT,
      title TEXT NOT NULL,
      is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled', 'error', 'inaccessible')),
      automation_blocked INTEGER NOT NULL DEFAULT 0 CHECK (automation_blocked IN (0, 1)),
      blocked_reason TEXT,
      blocked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE account_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      channel_id INTEGER NOT NULL,
      is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
      status TEXT NOT NULL DEFAULT 'healthy'
        CHECK (status IN ('pending', 'resolving', 'syncing', 'healthy', 'degraded', 'error', 'disabled', 'disconnected')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (account_id, channel_id),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
    );

    CREATE TABLE reply_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      body TEXT NOT NULL,
      is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (account_id, name),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL,
      channel_id INTEGER,
      reply_template_id INTEGER,
      name TEXT NOT NULL,
      trigger_keywords TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(trigger_keywords)),
      exclude_keywords TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(exclude_keywords)),
      cleanup_sender_patterns TEXT NOT NULL DEFAULT '["JGN REPLY"]' CHECK (json_valid(cleanup_sender_patterns)),
      is_enabled INTEGER NOT NULL DEFAULT 0 CHECK (is_enabled IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (owner_id, name),
      FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY (reply_template_id) REFERENCES reply_templates(id) ON DELETE SET NULL
    );

    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
      event_type TEXT NOT NULL,
      account_id INTEGER,
      channel_id INTEGER,
      rule_id INTEGER,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      error_reason TEXT,
      exclude_keyword TEXT,
      message TEXT,
      metadata TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL,
      FOREIGN KEY (rule_id) REFERENCES rules(id) ON DELETE SET NULL
    );

    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL CHECK (json_valid(value)),
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE account_automation_settings (
      account_id INTEGER PRIMARY KEY,
      reply_delay_ms INTEGER NOT NULL DEFAULT 100 CHECK (reply_delay_ms >= 100 AND reply_delay_ms <= 600000),
      auto_reaction INTEGER NOT NULL DEFAULT 0 CHECK (auto_reaction IN (0, 1)),
      cooldown_ms INTEGER NOT NULL DEFAULT 0 CHECK (cooldown_ms >= 0),
      hourly_limit INTEGER NOT NULL DEFAULT 0 CHECK (hourly_limit >= 0),
      daily_limit INTEGER NOT NULL DEFAULT 0 CHECK (daily_limit >= 0),
      notification_target TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      reaction_type TEXT NOT NULL DEFAULT '❤️' CHECK (length(trim(reaction_type)) BETWEEN 1 AND 32),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE automation_dispatches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      channel_id INTEGER NOT NULL,
      reply_template_id INTEGER,
      source_message_id INTEGER NOT NULL,
      reply_message_id INTEGER,
      matched_trigger TEXT NOT NULL,
      delay_ms INTEGER NOT NULL CHECK (delay_ms >= 0 AND delay_ms <= 600000),
      status TEXT NOT NULL CHECK (status IN ('scheduled', 'sent', 'failed', 'cooldown_skipped', 'limit_skipped')),
      reaction_status TEXT NOT NULL DEFAULT 'skipped' CHECK (reaction_status IN ('sent', 'skipped', 'failed')),
      reply_message_link TEXT,
      error_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      scheduled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      sent_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (channel_id, source_message_id, account_id),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY (reply_template_id) REFERENCES reply_templates(id) ON DELETE SET NULL
    );

    CREATE TABLE telegram_channel_sync_state (
      account_id INTEGER NOT NULL,
      channel_id INTEGER NOT NULL,
      pts INTEGER NOT NULL DEFAULT 1,
      sync_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (sync_status IN ('pending', 'connecting', 'syncing', 'healthy', 'degraded', 'error', 'disconnected')),
      last_successful_sync_at TEXT,
      last_attempted_sync_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (account_id, channel_id),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
    );
  `);

  const migrationInsert = database.prepare(
    'INSERT INTO schema_migrations (version, name) VALUES (?, ?)',
  );
  for (let version = 1; version <= 12; version += 1) {
    migrationInsert.run(version, `production_fixture_v${version}`);
  }

  database.exec(`
    INSERT INTO owners (id, telegram_user_id, is_active) VALUES (1, '111111111', 1);
    INSERT INTO accounts (
      id, owner_id, label, telegram_user_id, session_key, status, is_enabled, phone_number
    ) VALUES (
      1, 1, 'Shark', '222222222', 'account-00000000-0000-4000-8000-000000001301',
      'connected', 1, '+628111111111'
    );
    INSERT INTO reply_templates (id, account_id, name, body, is_enabled)
      VALUES (1, 1, 'Primary', 'reply preserved', 1);
    INSERT INTO settings (key, value, description)
      VALUES ('global_trigger_keywords', '["bucin"]', 'preserved setting');
    INSERT INTO account_automation_settings (
      account_id, reply_delay_ms, auto_reaction, cooldown_ms, hourly_limit,
      daily_limit, notification_target, reaction_type
    ) VALUES (1, 500, 1, 1000, 10, 50, 'saved_messages', '🔥');

    INSERT INTO channels (
      id, telegram_channel_id, username, title, is_enabled, status
    ) VALUES (7, '-1007000000007', 'legacy_channel', 'Legacy Channel', 1, 'active');
    INSERT INTO account_channels (id, account_id, channel_id, is_enabled, status)
      VALUES (8, 1, 7, 1, 'healthy');
    INSERT INTO telegram_channel_sync_state (
      account_id, channel_id, pts, sync_status
    ) VALUES (1, 7, 99, 'healthy');

    INSERT INTO rules (
      id, owner_id, channel_id, reply_template_id, name, trigger_keywords,
      exclude_keywords, cleanup_sender_patterns, is_enabled
    ) VALUES (1, 1, 7, 1, 'Global', '["bucin"]', '["jasa"]', '["JGN REPLY"]', 1);
    INSERT INTO logs (
      id, level, event_type, account_id, channel_id, rule_id, action, status, message
    ) VALUES (1, 'info', 'reply_sent', 1, 7, 1, 'reply', 'sent', 'history preserved');
    INSERT INTO automation_dispatches (
      id, account_id, channel_id, reply_template_id, source_message_id,
      reply_message_id, matched_trigger, delay_ms, status, reaction_status,
      reply_message_link, sent_at
    ) VALUES (
      1, 1, 7, 1, 700, 701, 'bucin', 500, 'sent', 'sent',
      'https://t.me/c/1/701', '2026-08-27T01:02:03.000Z'
    );
  `);

  database.close();
}

function openMigratedDatabase(databasePath: string): {
  readonly database: DatabaseSync;
  readonly closeLogger: () => void;
} {
  const logDirectory = path.join(path.dirname(databasePath), 'logs');
  const loggerHandle = createLogger({
    level: 'error',
    logDirectory,
    environment: 'test',
    writeToStdout: false,
  });
  const service = new DatabaseService(databasePath, loggerHandle.logger);
  service.initialize();
  const database = service.getConnection();
  return {
    database,
    closeLogger: () => {
      service.close();
      loggerHandle.close();
    },
  };
}

describe('migration v13 channel schema rebuild', () => {
  it('applies on a fresh database and starts with zero active channels', () => {
    const { databasePath, logDirectory } = createPaths('auto-wtb-channel-v13-fresh-');
    const loggerHandle = createLogger({
      level: 'error',
      logDirectory,
      environment: 'test',
      writeToStdout: false,
    });
    const service = new DatabaseService(databasePath, loggerHandle.logger);

    service.initialize();

    expect(service.getMigrationVersion()).toBe(14);
    expect(countRows(service.getConnection(), 'channels')).toBe(0);
    expect(countRows(service.getConnection(), 'account_channels')).toBe(0);
    expect(countRows(service.getConnection(), 'telegram_channel_sync_state')).toBe(0);
    expect(service.getConnection().prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    service.close();
    loggerHandle.close();
  });

  it('migrates a production-shaped v12 database without deleting unrelated data', () => {
    const { databasePath } = createPaths('auto-wtb-channel-v13-production-');
    createProductionShapedV12Database(databasePath);

    const migrated = openMigratedDatabase(databasePath);
    const database = migrated.database;

    expect(
      database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get(),
    ).toEqual({ version: 14 });
    expect(countRows(database, 'channels')).toBe(1);
    expect(countRows(database, 'account_channels')).toBe(1);
    expect(countRows(database, 'telegram_channel_sync_state')).toBe(1);

    expect(database.prepare('SELECT telegram_channel_id, status FROM channels WHERE id = 7').get()).toEqual({
      telegram_channel_id: '-1007000000007',
      status: 'healthy',
    });
    expect(
      database.prepare('SELECT account_id, channel_id, status FROM account_channels WHERE id = 8').get(),
    ).toEqual({
      account_id: 1,
      channel_id: 7,
      status: 'healthy',
    });

    expect(database.prepare('SELECT telegram_user_id FROM owners WHERE id = 1').get()).toEqual({
      telegram_user_id: '111111111',
    });
    expect(
      database.prepare('SELECT label, session_key, phone_number FROM accounts WHERE id = 1').get(),
    ).toEqual({
      label: 'Shark',
      session_key: 'account-00000000-0000-4000-8000-000000001301',
      phone_number: '+628111111111',
    });
    expect(database.prepare('SELECT body FROM reply_templates WHERE id = 1').get()).toEqual({
      body: 'reply preserved',
    });
    expect(database.prepare("SELECT value FROM settings WHERE key = 'global_trigger_keywords'").get()).toEqual({
      value: '["bucin"]',
    });
    expect(
      database.prepare('SELECT reply_delay_ms, reaction_type FROM account_automation_settings WHERE account_id = 1').get(),
    ).toEqual({ reply_delay_ms: 500, reaction_type: '🔥' });

    expect(database.prepare('SELECT id, name, channel_id FROM rules WHERE id = 1').get()).toEqual({
      id: 1,
      name: 'Global',
      channel_id: null,
    });
    expect(database.prepare('SELECT id, message, channel_id FROM logs WHERE id = 1').get()).toEqual({
      id: 1,
      message: 'history preserved',
      channel_id: null,
    });
    expect(
      database.prepare('SELECT id, channel_id, source_message_id, reply_message_id, status FROM automation_dispatches WHERE id = 1').get(),
    ).toEqual({
      id: 1,
      channel_id: 7,
      source_message_id: 700,
      reply_message_id: 701,
      status: 'sent',
    });
    expect(database.prepare('SELECT id, telegram_channel_id, title FROM channel_identity_history WHERE id = 7').get()).toEqual({
      id: 7,
      telegram_channel_id: '-1007000000007',
      title: 'Legacy Channel',
    });
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    migrated.closeLogger();
  });

  it('accepts every new channel lifecycle status and rejects the legacy active status', () => {
    const { databasePath } = createPaths('auto-wtb-channel-v13-status-');
    createProductionShapedV12Database(databasePath);
    const migrated = openMigratedDatabase(databasePath);
    const database = migrated.database;

    for (const [index, status] of CHANNEL_STATUSES.entries()) {
      database.prepare(`
        INSERT INTO channels (telegram_channel_id, title, status)
        VALUES (?, ?, ?)
      `).run(`-10080000000${index}`, `Status ${status}`, status);
    }

      expect(
        database.prepare('SELECT status FROM channels ORDER BY id').all().map((row) => row.status),
      ).toEqual(['healthy', ...CHANNEL_STATUSES]);
    expect(() =>
      database.prepare(`
        INSERT INTO channels (telegram_channel_id, title, status)
        VALUES ('-1008999999999', 'Legacy Active', 'active')
      `).run(),
    ).toThrow(/CHECK constraint failed/i);
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    migrated.closeLogger();
  });

  it('resets populated channel state and keeps future dispatch foreign keys valid', () => {
    const { databasePath } = createPaths('auto-wtb-channel-v13-populated-');
    createProductionShapedV12Database(databasePath);
    const migrated = openMigratedDatabase(databasePath);
    const database = migrated.database;

    expect(countRows(database, 'channels')).toBe(1);
    expect(countRows(database, 'account_channels')).toBe(1);
    expect(countRows(database, 'telegram_channel_sync_state')).toBe(1);
    expect(countRows(database, 'automation_dispatches')).toBe(1);

    const newChannel = database.prepare(`
      INSERT INTO channels (telegram_channel_id, username, title, status)
      VALUES ('-1009000000001', 'new_channel', 'New Channel', 'pending')
      RETURNING id
    `).get();
    const newChannelId = Number(newChannel?.id);

    expect(newChannelId).toBeGreaterThan(7);
    database.prepare(`
      INSERT INTO account_channels (account_id, channel_id, is_enabled, status)
      VALUES (1, ?, 1, 'pending')
    `).run(newChannelId);
    database.prepare(`
      INSERT INTO automation_dispatches (
        account_id, channel_id, reply_template_id, source_message_id,
        matched_trigger, delay_ms, status
      ) VALUES (1, ?, 1, 900, 'bucin', 500, 'scheduled')
    `).run(newChannelId);

    expect(database.prepare('SELECT telegram_channel_id FROM channel_identity_history WHERE id = ?').get(newChannelId)).toEqual({
      telegram_channel_id: '-1009000000001',
    });
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    migrated.closeLogger();
  });
});
