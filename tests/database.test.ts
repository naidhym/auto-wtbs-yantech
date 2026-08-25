import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import {
  DatabaseService,
  FOUNDATION_TABLES,
  configureSqliteConnection,
} from '../src/database/database.service.js';
import { runInTransaction } from '../src/database/transaction.js';
import { foundationMigration } from '../src/database/migrations/0001-foundation.js';
import { accountSessionMigration } from '../src/database/migrations/0002-account-session.js';
import { independentChannelsMigration } from '../src/database/migrations/0003-independent-channels.js';
import { perAccountDispatchDeduplicationMigration } from '../src/database/migrations/0007-per-account-dispatch-deduplication.js';
import { createLogger } from '../src/logging/logger.js';

function createTestPaths(prefix: string): {
  readonly runtimeDirectory: string;
  readonly databasePath: string;
  readonly logDirectory: string;
} {
  const runtimeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const databasePath = path.join(runtimeDirectory, 'data', 'foundation.sqlite');
  const logDirectory = path.join(runtimeDirectory, 'logs');
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  return { runtimeDirectory, databasePath, logDirectory };
}

describe('database foundation', () => {
  it('creates all foundation tables and applies migrations idempotently', () => {
    const { databasePath, logDirectory } = createTestPaths('auto-wtb-db-');
    const loggerHandle = createLogger({
      level: 'error',
      logDirectory,
      environment: 'test',
      writeToStdout: false,
    });

    const first = new DatabaseService(databasePath, loggerHandle.logger);
    first.initialize();
    expect(first.getMigrationVersion()).toBe(9);
    expect(first.getTableNames()).toEqual(
      [...FOUNDATION_TABLES, 'schema_migrations'].sort(),
    );
    expect(first.getConnection().prepare(`
      SELECT value FROM settings WHERE key = 'global_automation_enabled'
    `).get()).toEqual({ value: 'true' });
    expect(first.getConnection().prepare(`
      SELECT name FROM pragma_table_info('channels')
      WHERE name IN ('automation_blocked', 'blocked_reason', 'blocked_at')
      ORDER BY name
    `).all()).toEqual([
      { name: 'automation_blocked' },
      { name: 'blocked_at' },
      { name: 'blocked_reason' },
    ]);
    expect(first.getConnection().prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    first.ensureOwner('123456789');
    first.getConnection().exec(`
      INSERT INTO accounts (id, owner_id, label, session_key, phone_number) VALUES
        (1, 1, 'Account A', 'account-00000000-0000-4000-8000-000000000701', '+628111111111'),
        (2, 1, 'Account B', 'account-00000000-0000-4000-8000-000000000702', '+628222222222');
      INSERT INTO channels (id, telegram_channel_id, title) VALUES (1, '7001', 'Dispatch Channel');
      INSERT INTO automation_dispatches (
        account_id, channel_id, source_message_id, matched_trigger, delay_ms, status
      ) VALUES
        (1, 1, 77, 'bucin', 0, 'scheduled'),
        (2, 1, 77, 'bucin', 0, 'scheduled');
    `);
    expect(() => first.getConnection().prepare(`
      INSERT INTO automation_dispatches (
        account_id, channel_id, source_message_id, matched_trigger, delay_ms, status
      ) VALUES (1, 1, 77, 'bucin', 0, 'scheduled')
    `).run()).toThrow(/UNIQUE constraint failed/i);
    first.close();

    const second = new DatabaseService(databasePath, loggerHandle.logger);
    second.initialize();
    expect(second.getMigrationVersion()).toBe(9);
    expect(second.getTableNames()).toEqual(
      [...FOUNDATION_TABLES, 'schema_migrations'].sort(),
    );
    second.close();
    loggerHandle.close();
  });

  it('keeps WAL, foreign keys, busy timeout, and prepared statements enabled', () => {
    const { databasePath, logDirectory } = createTestPaths('auto-wtb-pragmas-');
    const loggerHandle = createLogger({
      level: 'error',
      logDirectory,
      environment: 'test',
      writeToStdout: false,
    });
    const service = new DatabaseService(databasePath, loggerHandle.logger);
    service.initialize();
    service.ensureOwner('987654321');
    service.close();

    const connection = new DatabaseSync(databasePath, {
      enableForeignKeyConstraints: false,
    });
    configureSqliteConnection(connection);

    expect(connection.prepare('PRAGMA journal_mode').get()).toEqual({
      journal_mode: 'wal',
    });
    expect(connection.prepare('PRAGMA foreign_keys').get()).toEqual({
      foreign_keys: 1,
    });
    expect(connection.prepare('PRAGMA busy_timeout').get()).toEqual({
      timeout: 5000,
    });
    expect(
      connection
        .prepare('SELECT telegram_user_id FROM owners WHERE telegram_user_id = ?')
        .get('987654321'),
    ).toEqual({ telegram_user_id: '987654321' });
    expect(
      connection.prepare("SELECT name FROM pragma_table_info('accounts') WHERE name = ?").get(
        'phone_number',
      ),
    ).toEqual({ name: 'phone_number' });
    const accountColumns = connection
      .prepare("SELECT name FROM pragma_table_info('accounts')")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(accountColumns).not.toEqual(
      expect.arrayContaining(['otp', 'password', 'api_hash', 'session']),
    );
    expect(() =>
      connection
        .prepare(
          `
            INSERT INTO accounts (owner_id, label, session_key)
            VALUES (?, ?, ?)
          `,
        )
        .run(999999, 'invalid-owner', 'invalid-owner-session'),
    ).toThrow(/FOREIGN KEY constraint failed/i);

    connection.close();
    loggerHandle.close();
  });

  it('rolls back a failed transaction', () => {
    const connection = new DatabaseSync(':memory:');
    connection.exec('CREATE TABLE transaction_test (value TEXT NOT NULL)');

    expect(() =>
      runInTransaction(connection, () => {
        connection
          .prepare('INSERT INTO transaction_test (value) VALUES (?)')
          .run('should-rollback');
        throw new Error('intentional transaction failure');
      }),
    ).toThrow('intentional transaction failure');
    expect(
      connection.prepare('SELECT COUNT(*) AS count FROM transaction_test').get(),
    ).toEqual({ count: 0 });

    connection.close();
  });

  it('preserves v6 dispatch records while changing duplicate protection to per account', () => {
    const connection = new DatabaseSync(':memory:');
    connection.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE accounts (id INTEGER PRIMARY KEY);
      CREATE TABLE channels (id INTEGER PRIMARY KEY);
      CREATE TABLE reply_templates (id INTEGER PRIMARY KEY);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, description TEXT NOT NULL);
      CREATE TABLE automation_dispatches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        channel_id INTEGER NOT NULL,
        reply_template_id INTEGER,
        source_message_id INTEGER NOT NULL,
        reply_message_id INTEGER,
        matched_trigger TEXT NOT NULL,
        delay_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        reaction_status TEXT NOT NULL DEFAULT 'skipped',
        reply_message_link TEXT,
        error_reason TEXT,
        created_at TEXT NOT NULL,
        scheduled_at TEXT NOT NULL,
        sent_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (channel_id, source_message_id)
      );
      CREATE INDEX idx_automation_dispatch_account_sent
        ON automation_dispatches(account_id, status, sent_at DESC);
      CREATE INDEX idx_automation_dispatch_channel_source
        ON automation_dispatches(channel_id, source_message_id);
      INSERT INTO accounts (id) VALUES (1), (2);
      INSERT INTO channels (id) VALUES (1);
      INSERT INTO settings (key, value, description) VALUES
        ('automation_dispatch_round_robin_channel_1', '1', 'obsolete');
      INSERT INTO automation_dispatches (
        id, account_id, channel_id, source_message_id, matched_trigger, delay_ms,
        status, reaction_status, created_at, scheduled_at, updated_at
      ) VALUES (9, 1, 1, 61, 'bucin', 2000, 'sent', 'skipped', '2026-01-01', '2026-01-01', '2026-01-01');
    `);

    perAccountDispatchDeduplicationMigration.up(connection);
    connection.exec('PRAGMA foreign_keys = ON;');

    expect(connection.prepare(`
      SELECT id, account_id, channel_id, source_message_id, matched_trigger, delay_ms, status
      FROM automation_dispatches WHERE id = 9
    `).get()).toEqual({
      id: 9,
      account_id: 1,
      channel_id: 1,
      source_message_id: 61,
      matched_trigger: 'bucin',
      delay_ms: 2000,
      status: 'sent',
    });
    connection.prepare(`
      INSERT INTO automation_dispatches (
        account_id, channel_id, source_message_id, matched_trigger, delay_ms,
        status, reaction_status, created_at, scheduled_at, updated_at
      ) VALUES (2, 1, 61, 'bucin', 0, 'scheduled', 'skipped', '2026-01-02', '2026-01-02', '2026-01-02')
    `).run();
    expect(() => connection.prepare(`
      INSERT INTO automation_dispatches (
        account_id, channel_id, source_message_id, matched_trigger, delay_ms,
        status, reaction_status, created_at, scheduled_at, updated_at
      ) VALUES (1, 1, 61, 'bucin', 0, 'scheduled', 'skipped', '2026-01-02', '2026-01-02', '2026-01-02')
    `).run()).toThrow(/UNIQUE constraint failed/i);
    expect(connection.prepare(`
      SELECT value FROM settings WHERE key = 'automation_dispatch_round_robin_channel_1'
    `).get()).toBeUndefined();
    expect(connection.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    connection.close();
  });

  it('migrates M1/M2 account-owned channels safely and idempotently', () => {
    const { databasePath, logDirectory } = createTestPaths('auto-wtb-m3-migration-');
    const legacy = new DatabaseSync(databasePath);
    configureSqliteConnection(legacy);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);
    foundationMigration.up(legacy);
    accountSessionMigration.up(legacy);
    legacy.exec(`
      INSERT INTO schema_migrations (version, name) VALUES
        (1, 'foundation_schema'), (2, 'account_session');
      INSERT INTO owners (id, telegram_user_id) VALUES (1, '123');
      INSERT INTO accounts (id, owner_id, label, session_key, phone_number) VALUES
        (1, 1, 'A', 'account-00000000-0000-4000-8000-000000000801', '+628111111111'),
        (2, 1, 'B', 'account-00000000-0000-4000-8000-000000000802', '+628222222222');
      INSERT INTO channels (id, account_id, telegram_channel_id, username, title, is_active) VALUES
        (10, 1, '9001', 'shared', 'Shared', 1),
        (11, 2, '9001', 'shared', 'Shared', 1);
      INSERT INTO rules (id, account_id, channel_id, name) VALUES
        (1, 2, 11, 'legacy-rule');
      INSERT INTO logs (level, event_type, channel_id, action, status) VALUES
        ('info', 'legacy', 11, 'legacy', 'ok');
    `);
    legacy.close();

    const logger = createLogger({
      level: 'error',
      logDirectory,
      environment: 'test',
      writeToStdout: false,
    });
    const service = new DatabaseService(databasePath, logger.logger);
    service.initialize();
    const connection = service.getConnection();
    expect(service.getMigrationVersion()).toBe(9);
    expect(connection.prepare('SELECT COUNT(*) AS count FROM channels').get())
      .toEqual({ count: 1 });
    expect(connection.prepare('SELECT COUNT(*) AS count FROM account_channels').get())
      .toEqual({ count: 2 });
    expect(connection.prepare('SELECT channel_id FROM rules WHERE id = 1').get())
      .toEqual({ channel_id: 10 });
    expect(connection.prepare('SELECT channel_id FROM logs WHERE event_type = ?').get('legacy'))
      .toEqual({ channel_id: 10 });
    expect(connection.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    service.close();

    const reopened = new DatabaseService(databasePath, logger.logger);
    reopened.initialize();
    expect(reopened.getMigrationVersion()).toBe(9);
    expect(reopened.getConnection().prepare('SELECT COUNT(*) AS count FROM account_channels').get())
      .toEqual({ count: 2 });
    reopened.close();
    logger.close();
  });

  it('migrates legacy templates losslessly back to account scope idempotently', () => {
    const { databasePath, logDirectory } = createTestPaths('auto-wtb-m4-migration-');
    const legacy = new DatabaseSync(databasePath);
    configureSqliteConnection(legacy);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);
    foundationMigration.up(legacy);
    accountSessionMigration.up(legacy);
    legacy.exec(`
      INSERT INTO owners (id, telegram_user_id) VALUES (1, '123');
      INSERT INTO accounts (id, owner_id, label, session_key, phone_number) VALUES
        (1, 1, 'Legacy A', 'account-00000000-0000-4000-8000-000000000991', '+628111111111'),
        (2, 1, 'Legacy B', 'account-00000000-0000-4000-8000-000000000992', '+628222222222');
      INSERT INTO channels (id, account_id, telegram_channel_id, title, is_active)
      VALUES (5, 1, '5005', 'Legacy Channel', 1);
    `);
    legacy.exec('PRAGMA foreign_keys = OFF;');
    independentChannelsMigration.up(legacy);
    legacy.exec('PRAGMA foreign_keys = ON;');
    legacy.exec(`
      INSERT INTO reply_templates (id, account_id, name, body, is_active)
      VALUES (7, 1, 'Legacy Reply', 'Legacy body', 1);
      INSERT INTO rules (
        id, account_id, channel_id, reply_template_id, name,
        trigger_keywords, exclude_keywords, is_enabled
      ) VALUES (8, 1, 5, 7, 'Legacy Rule', '["bucin"]', '["fmv"]', 1);
      INSERT INTO schema_migrations (version, name) VALUES
        (1, 'foundation_schema'),
        (2, 'account_session'),
        (3, 'independent_channels');
    `);
    legacy.close();

    const logger = createLogger({ level: 'error', logDirectory, environment: 'test', writeToStdout: false });
    const service = new DatabaseService(databasePath, logger.logger);
    service.initialize();
    const connection = service.getConnection();
    expect(service.getMigrationVersion()).toBe(9);
    expect(connection.prepare(`
      SELECT id, account_id, name, body, is_enabled FROM reply_templates WHERE id = 7
    `).get()).toEqual({
      id: 7,
      account_id: 1,
      name: 'Legacy Reply',
      body: 'Legacy body',
      is_enabled: 1,
    });
    expect(connection.prepare(`
      SELECT account_id, name, body, is_enabled
      FROM reply_templates WHERE account_id = 2
    `).get()).toEqual({
      account_id: 2,
      name: 'Legacy Reply',
      body: 'Legacy body',
      is_enabled: 1,
    });
    expect(connection.prepare('SELECT COUNT(*) AS count FROM reply_templates').get())
      .toEqual({ count: 2 });
    expect(connection.prepare(`
      SELECT id, owner_id, channel_id, reply_template_id, cleanup_sender_patterns, is_enabled
      FROM rules WHERE id = 8
    `).get()).toEqual({
      id: 8,
      owner_id: 1,
      channel_id: 5,
      reply_template_id: 7,
      cleanup_sender_patterns: '["JGN REPLY"]',
      is_enabled: 1,
    });
    const ruleColumns = connection.prepare("SELECT name FROM pragma_table_info('rules')").all()
      .map((row) => (row as { name: string }).name);
    expect(ruleColumns).toContain('owner_id');
    expect(ruleColumns).not.toContain('account_id');
    expect(connection.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    service.close();

    const reopened = new DatabaseService(databasePath, logger.logger);
    reopened.initialize();
    expect(reopened.getMigrationVersion()).toBe(9);
    expect(reopened.getConnection().prepare('SELECT COUNT(*) AS count FROM rules').get())
      .toEqual({ count: 1 });
    reopened.close();
    logger.close();
  });
});
