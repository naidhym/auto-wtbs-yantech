import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { DatabaseService } from '../src/database/database.service.js';
import { rebuildAccountChannelsStatusMigration } from '../src/database/migrations/0014-rebuild-account-channels-status.js';
import { ChannelRepository } from '../src/channels/channel.repository.js';
import { createLogger } from '../src/logging/logger.js';

const ACCOUNT_CHANNELS_STATUSES = [
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

function openService(databasePath: string, logDirectory: string): DatabaseService {
  const loggerHandle = createLogger({
    level: 'error',
    logDirectory,
    environment: 'test',
    writeToStdout: false,
  });
  const service = new DatabaseService(databasePath, loggerHandle.logger);
  service.initialize();
  return service;
}

describe('v14 account_channels.status contract', () => {
  it('applies on a fresh database and enforces the operational status set', () => {
    const { databasePath, logDirectory } = createPaths('auto-wtb-acs-fresh-');
    const service = openService(databasePath, logDirectory);
    const database = service.getConnection();

    expect(service.getMigrationVersion()).toBe(14);

    // Backing rows so the CHECK (not a foreign key) is the constraint under test.
    database.exec(`
      INSERT INTO owners (id, telegram_user_id) VALUES (1, 'owner');
      INSERT INTO accounts (id, owner_id, label, session_key, status, is_enabled)
        VALUES (1, 1, 'A', 'account-00000000-0000-4000-8000-000000000001', 'disconnected', 1);
      INSERT INTO channels (id, telegram_channel_id, title, is_enabled, status)
        VALUES (1, '7000000001', 'One', 1, 'healthy'),
               (2, '7000000002', 'Two', 1, 'healthy'),
               (3, '7000000003', 'Three', 1, 'healthy'),
               (4, '7000000004', 'Four', 1, 'healthy'),
               (5, '7000000005', 'Five', 1, 'healthy'),
               (6, '7000000006', 'Six', 1, 'healthy'),
               (7, '7000000007', 'Seven', 1, 'healthy'),
               (8, '7000000008', 'Eight', 1, 'healthy');
    `);

    // Every valid operational status is accepted (one distinct channel per status
    // because UNIQUE(account_id, channel_id) applies).
    const insert = database.prepare(
      `INSERT INTO account_channels (account_id, channel_id, is_enabled, status)
       VALUES (1, ?, 1, ?)`,
    );
    ACCOUNT_CHANNELS_STATUSES.forEach((status, index) => insert.run(index + 1, status));
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM account_channels').get(),
    ).toEqual({ count: ACCOUNT_CHANNELS_STATUSES.length });

    // Legacy / invalid statuses are rejected by the CHECK constraint.
    for (const bad of ['active', 'inaccessible', 'connected', 'pendingx']) {
      expect(() =>
        database.prepare('UPDATE account_channels SET status = ? WHERE id = 1').run(bad),
      ).toThrow(/CHECK constraint failed/i);
    }

    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    service.close();
  });

  it('rebuilds a legacy account_channels.status CHECK (v13 drift) to the new contract and remaps rows', () => {
    const { databasePath, logDirectory } = createPaths('auto-wtb-acs-legacy-');
    const service = openService(databasePath, logDirectory);
    const database = service.getConnection();

    // Simulate a production database that still carries the legacy CHECK on
    // account_channels.status (built before the operational-status redesign).
    database.exec('PRAGMA foreign_keys = OFF;');
    database.exec(`
      DROP TABLE account_channels;
      CREATE TABLE account_channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        channel_id INTEGER NOT NULL,
        is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'disabled', 'error', 'inaccessible')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%fZ', 'now')),
        UNIQUE (account_id, channel_id),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
      );
    `);
    database.exec(`
      INSERT INTO owners (id, telegram_user_id) VALUES (1, 'owner');
      INSERT INTO accounts (id, owner_id, label, session_key, status, is_enabled)
        VALUES (1, 1, 'A', 'account-00000000-0000-4000-8000-000000000001', 'disconnected', 1);
      INSERT INTO channels (id, telegram_channel_id, title, is_enabled, status)
        VALUES (1, '7000000001', 'Legacy Channel', 1, 'healthy');
      INSERT INTO account_channels (account_id, channel_id, is_enabled, status)
        VALUES (1, 1, 1, 'active');
    `);
    database.exec('PRAGMA foreign_keys = ON;');

    // Re-run the v14 rebuild directly against the drifted schema.
    rebuildAccountChannelsStatusMigration.up(database);

    // The legacy 'active' row is remapped to the nearest valid operational state.
    expect(
      database.prepare('SELECT status FROM account_channels WHERE id = 1').get(),
    ).toEqual({ status: 'healthy' });

    // The new CHECK now accepts the full operational vocabulary. The remapped row
    // (id = 1) already proves 'active' -> 'healthy'; here we confirm every other
    // operational status can be written to an existing assignment.
    for (const status of ACCOUNT_CHANNELS_STATUSES) {
      database.prepare('UPDATE account_channels SET status = ? WHERE id = 1').run(status);
      expect(
        database.prepare('SELECT status FROM account_channels WHERE id = 1').get(),
      ).toEqual({ status });
    }

    // Legacy values are no longer accepted.
    expect(() =>
      database.prepare("UPDATE account_channels SET status = 'inaccessible' WHERE id = 1").run(),
    ).toThrow(/CHECK constraint failed/i);

    service.close();
  });

  it('preserves foreign keys, indexes and the UNIQUE(account_id, channel_id) constraint', () => {
    const { databasePath, logDirectory } = createPaths('auto-wtb-acs-integrity-');
    const service = openService(databasePath, logDirectory);
    const database = service.getConnection();

    database.exec(`
      INSERT INTO owners (id, telegram_user_id) VALUES (1, 'owner');
      INSERT INTO accounts (id, owner_id, label, session_key, status, is_enabled)
        VALUES (1, 1, 'A', 'account-00000000-0000-4000-8000-000000000001', 'disconnected', 1);
      INSERT INTO channels (id, telegram_channel_id, title, is_enabled, status)
        VALUES (1, '7000000001', 'C', 1, 'healthy');
      INSERT INTO account_channels (account_id, channel_id, is_enabled, status)
        VALUES (1, 1, 1, 'healthy');
    `);

    // UNIQUE(account_id, channel_id) is preserved.
    expect(() =>
      database.prepare(
        `INSERT INTO account_channels (account_id, channel_id, is_enabled, status)
         VALUES (1, 1, 1, 'healthy')`,
      ).run(),
    ).toThrow(/UNIQUE constraint failed/i);

    // Indexes are intact.
    const indexNames = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'account_channels'")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(indexNames).toContain('idx_account_channels_account_id');
    expect(indexNames).toContain('idx_account_channels_channel_id');
    expect(indexNames).toContain('idx_account_channels_effective');

    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    service.close();
  });

  it('creates assignments through bulk channel creation without a CHECK failure', () => {
    const { databasePath, logDirectory } = createPaths('auto-wtb-acs-bulk-');
    const service = openService(databasePath, logDirectory);
    const database = service.getConnection();
    const repository = new ChannelRepository(database);

    database.exec(`
      INSERT INTO owners (id, telegram_user_id) VALUES (1, 'owner');
      INSERT INTO accounts (id, owner_id, label, session_key, status, is_enabled)
        VALUES (1, 1, 'A', 'account-00000000-0000-4000-8000-000000000001', 'disconnected', 1);
    `);

    const channels = repository.saveBulkResolved([
      { telegramChannelId: '7000000001', title: 'One' },
      { telegramChannelId: '7000000002', title: 'Two' },
    ]);
    const assignments = repository.assignBulk(1, channels.map((channel) => channel.id));

    expect(assignments).toHaveLength(2);
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM account_channels').get(),
    ).toEqual({ count: 2 });
    expect(
      database.prepare('SELECT status FROM account_channels').all(),
    ).toEqual([{ status: 'pending' }, { status: 'pending' }]);

    service.close();
  });

  it('supports the full assignment status lifecycle transitions', () => {
    const { databasePath, logDirectory } = createPaths('auto-wtb-acs-transitions-');
    const service = openService(databasePath, logDirectory);
    const database = service.getConnection();
    const repository = new ChannelRepository(database);

    database.exec(`
      INSERT INTO owners (id, telegram_user_id) VALUES (1, 'owner');
      INSERT INTO accounts (id, owner_id, label, session_key, status, is_enabled)
        VALUES (1, 1, 'A', 'account-00000000-0000-4000-8000-000000000001', 'disconnected', 1);
      INSERT INTO channels (id, telegram_channel_id, title, is_enabled, status)
        VALUES (1, '7000000001', 'C', 1, 'healthy');
    `);
    const assignment = repository.assign(1, 1);
    expect(assignment.status).toBe('healthy');

    for (const status of ACCOUNT_CHANNELS_STATUSES) {
      repository.setAssignmentStatus(assignment.id, status);
      expect(
        repository.getAssignment(1, 1)?.status,
      ).toBe(status);
    }

    service.close();
  });

  it('still starts cleanly with a zero-channel subsystem', () => {
    const { databasePath, logDirectory } = createPaths('auto-wtb-acs-zero-');
    const service = openService(databasePath, logDirectory);
    const database = service.getConnection();

    expect(service.getMigrationVersion()).toBe(14);
    expect(database.prepare('SELECT COUNT(*) AS count FROM channels').get()).toEqual({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM account_channels').get()).toEqual({ count: 0 });
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM telegram_channel_sync_state').get(),
    ).toEqual({ count: 0 });

    // A new channel can resolve -> create -> assign without tripping the CHECK.
    const repository = new ChannelRepository(database);
    database.exec(`
      INSERT INTO owners (id, telegram_user_id) VALUES (1, 'owner');
      INSERT INTO accounts (id, owner_id, label, session_key, status, is_enabled)
        VALUES (1, 1, 'A', 'account-00000000-0000-4000-8000-000000000001', 'disconnected', 1);
    `);
    const channel = repository.saveResolved({
      telegramChannelId: '7000000001',
      title: 'Fresh',
    });
    expect(channel.status).toBe('pending');
    const assignment = repository.assign(1, channel.id);
    expect(assignment.status).toBe('healthy');

    service.close();
  });
});
