import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { afterAll, describe, expect, it } from 'vitest';

import { DatabaseService, FOUNDATION_TABLES, configureSqliteConnection } from '../src/database/database.service.js';
import { rebuildChannelSchemaMigration } from '../src/database/migrations/0013-rebuild-channel-schema.js';
import { migrations } from '../src/database/migrations/index.js';
import { runInTransaction } from '../src/database/transaction.js';
import type { AppLogger } from '../src/logging/logger.js';

const stubLogger = new Proxy({}, { get: () => () => {} }) as unknown as AppLogger;

// Synthetic, fully deterministic production-like identities. These are FAKE and
// must never reference the real operator account (@SecondYan Yan) nor the real
// production database. The fixture is built from scratch via the real migration
// runner, so it is independent of whatever the working DB currently is.
const SYNTHETIC_OWNER_TG = '100000000';
const SYNTHETIC_ACCOUNTS = [
  { id: 1, label: 'SyntheticMonitorAlpha', tg: '2000000001', status: 'connected', isEnabled: true },
  { id: 2, label: 'SyntheticMonitorBravo', tg: '2000000002', status: 'connected', isEnabled: true },
  { id: 3, label: 'SyntheticMonitorCharlie', tg: '2000000003', status: 'disconnected', isEnabled: false },
];
const SYNTHETIC_CHANNELS = [
  { tg: '1611324665', username: 'syn_chan_alpha', title: 'Synthetic Channel Alpha' },
  { tg: '1303979309', username: 'syn_chan_bravo', title: 'Synthetic Channel Bravo' },
  { tg: '1441823150', username: 'syn_chan_charlie', title: 'Synthetic Channel Charlie' },
];

const MIGRATION_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )
`;

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
});

function makeTempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-safety-'));
  tempDirs.push(dir);
  return path.join(dir, 'test.sqlite');
}

function getVersion(db: DatabaseSync): number {
  return (db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number }).v;
}

function fkViolationCount(db: DatabaseSync): number {
  db.exec('PRAGMA foreign_keys = ON;');
  return (db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function countRows(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

function openRead(p: string): DatabaseSync {
  return new DatabaseSync(p, { readOnly: true });
}

// Replicates DatabaseService.runMigrations but only applies migrations up to and
// including `maxVersion`, so we can construct a genuinely v8 database (the real
// migration runner / up functions are used, not a copy of a production DB).
function migrateUpTo(connection: DatabaseSync, maxVersion: number): void {
  connection.exec('PRAGMA foreign_keys = ON;');
  connection.exec(MIGRATION_TABLE_SQL);
  const applied = new Set(
    (connection.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  );

  for (const migration of migrations) {
    if (migration.version > maxVersion) continue;
    if (applied.has(migration.version)) continue;

    if (migration.foreignKeysDisabled === true) {
      connection.exec('PRAGMA foreign_keys = OFF;');
    }

    try {
      runInTransaction(connection, () => {
        migration.up(connection);
        const violations = connection.prepare('PRAGMA foreign_key_check').all() as unknown[];
        if (violations.length > 0) {
          throw new Error(`Migration ${migration.version} introduced foreign key violations`);
        }
        connection
          .prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
          .run(migration.version, migration.name);
      });
    } finally {
      if (migration.foreignKeysDisabled === true) {
        connection.exec('PRAGMA foreign_keys = ON;');
      }
    }
  }
}

// Builds an isolated, synthetic v8 database entirely from the real migration
// runner (migrations 0001..0008) and seeds production-shaped data. Returns the
// path to a DB that is EXACTLY at migration v8; the caller then runs the real
// DatabaseService to execute migrations 0009..0014.
function buildV8Fixture(): string {
  const dbPath = makeTempDb();
  const connection = new DatabaseSync(dbPath);
  configureSqliteConnection(connection);
  migrateUpTo(connection, 8);

  if (getVersion(connection) !== 8) {
    connection.close();
    throw new Error(`v8 fixture builder produced version ${getVersion(connection)}, expected 8`);
  }

  const ownerId = Number(
    connection
      .prepare('INSERT INTO owners (telegram_user_id, is_active) VALUES (?, 1)')
      .run(SYNTHETIC_OWNER_TG).lastInsertRowid,
  );

  const insertAccount = connection.prepare(
    `INSERT INTO accounts (owner_id, label, telegram_user_id, session_key, status, is_enabled)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const a of SYNTHETIC_ACCOUNTS) {
    insertAccount.run(ownerId, a.label, a.tg, `account-${randomUUID()}`, a.status, a.isEnabled ? 1 : 0);
  }

  const insertAas = connection.prepare('INSERT INTO account_automation_settings (account_id) VALUES (?)');
  for (const a of SYNTHETIC_ACCOUNTS) insertAas.run(a.id);

  const insertTpl = connection.prepare('INSERT INTO reply_templates (account_id, name, body) VALUES (?, ?, ?)');
  insertTpl.run(1, 'tpl_alpha', 'Alpha body');
  insertTpl.run(2, 'tpl_bravo', 'Bravo body');

  const insertChannel = connection.prepare(
    `INSERT INTO channels (telegram_channel_id, username, title, is_enabled, status)
     VALUES (?, ?, ?, 1, 'healthy')`,
  );
  const channelIds: number[] = [];
  for (const c of SYNTHETIC_CHANNELS) {
    channelIds.push(Number(insertChannel.run(c.tg, c.username, c.title).lastInsertRowid));
  }
  const [c0, c1] = channelIds as [number, number, number];

  const insertAssign = connection.prepare(
    `INSERT INTO account_channels (account_id, channel_id, is_enabled, status) VALUES (?, ?, 1, 'healthy')`,
  );
  for (const a of SYNTHETIC_ACCOUNTS) {
    for (const cid of channelIds) insertAssign.run(a.id, cid);
  }

  const insertDispatch = connection.prepare(
    `INSERT INTO automation_dispatches (account_id, channel_id, reply_template_id, source_message_id, matched_trigger, delay_ms, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertDispatch.run(1, c0, 1, 1001, 'keyword', 1000, 'sent');
  insertDispatch.run(2, c1, 2, 2001, 'keyword', 1000, 'sent');

  // rules/logs reference a channel so we can prove migration 0013 detaches the
  // deprecated per-channel linkage while preserving the rows themselves.
  const insertRule = connection.prepare(
    `INSERT INTO rules (owner_id, channel_id, reply_template_id, name, trigger_keywords, is_enabled)
     VALUES (?, ?, ?, ?, '[]', 1)`,
  );
  insertRule.run(ownerId, c0, 1, 'rule_alpha');

  const insertLog = connection.prepare(
    `INSERT INTO logs (level, event_type, account_id, channel_id, action, status) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insertLog.run('info', 'dispatch', 1, c0, 'send', 'success');

  connection.close();
  return dbPath;
}

describe('migration safety: production channel subsystem is preserved', () => {
  it('fresh database: all migrations apply, reaches v14 with full foundation schema', () => {
    const dbPath = makeTempDb();
    const service = new DatabaseService(dbPath, stubLogger);
    service.initialize();

    const db = openRead(dbPath);
    expect(getVersion(db)).toBe(14);

    for (const table of FOUNDATION_TABLES) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      expect(row, `foundation table ${table} should exist`).toBeTruthy();
    }

    expect(fkViolationCount(db)).toBe(0);
    db.close();
    service.close();
  });

  it('v8 fixture: synthetic production data survives migrations 9-14 and reaches v14', () => {
    const dbPath = buildV8Fixture();

    const pre = new DatabaseSync(dbPath);
    expect(getVersion(pre)).toBe(8);
    // Pre-migration proofs: tables created by 0009 / 0013 must not exist yet.
    expect(tableExists(pre, 'telegram_channel_sync_state')).toBe(false);
    expect(tableExists(pre, 'channel_identity_history')).toBe(false);

    const preAccounts = countRows(pre, 'accounts');
    const preChannels = countRows(pre, 'channels');
    const preAssign = countRows(pre, 'account_channels');
    const preDispatch = countRows(pre, 'automation_dispatches');
    const preRules = countRows(pre, 'rules');
    const preTpl = countRows(pre, 'reply_templates');
    const preLogs = countRows(pre, 'logs');
    const preChannelTg = new Set(
      (pre.prepare('SELECT telegram_channel_id FROM channels').all() as { telegram_channel_id: string }[]).map(
        (r) => r.telegram_channel_id,
      ),
    );
    const preAssignPairs = new Set(
      (
        pre.prepare('SELECT account_id, channel_id FROM account_channels').all() as {
          account_id: number;
          channel_id: number;
        }[]
      ).map((r) => `${r.account_id}:${r.channel_id}`),
    );
    pre.close();

    const service = new DatabaseService(dbPath, stubLogger);
    service.initialize();

    const db = openRead(dbPath);
    expect(getVersion(db)).toBe(14);
    console.log('[migration-safety] v8 fixture executed through migrations 0009..0014; final version =', getVersion(db));

    // Tables created by 0009 and 0013 now exist.
    expect(tableExists(db, 'telegram_channel_sync_state')).toBe(true);
    expect(tableExists(db, 'channel_identity_history')).toBe(true);
    expect(countRows(db, 'channel_identity_history')).toBe(preChannels);

    // All synthetic data survived the run.
    expect(countRows(db, 'accounts')).toBe(preAccounts);
    expect(countRows(db, 'channels')).toBe(preChannels);
    expect(countRows(db, 'account_channels')).toBe(preAssign);
    expect(countRows(db, 'automation_dispatches')).toBe(preDispatch);
    expect(countRows(db, 'rules')).toBe(preRules);
    expect(countRows(db, 'reply_templates')).toBe(preTpl);
    expect(countRows(db, 'logs')).toBe(preLogs);

    // Account identities preserved exactly (including fake labels, never the real operator).
    const accountRows = db
      .prepare('SELECT id, label, telegram_user_id, status, is_enabled FROM accounts ORDER BY id')
      .all() as { id: number; label: string; telegram_user_id: string; status: string; is_enabled: number }[];
    expect(accountRows.length).toBe(3);
    expect(accountRows.map((a) => a.label)).toEqual(SYNTHETIC_ACCOUNTS.map((a) => a.label));
    for (const a of accountRows) {
      const before = SYNTHETIC_ACCOUNTS.find((s) => s.id === a.id);
      expect(before, `account ${a.id} must have existed before migration`).toBeTruthy();
      expect(a.label).toBe(before!.label);
      expect(a.telegram_user_id).toBe(before!.tg);
      expect(a.status).toBe(before!.status);
      expect(a.is_enabled).toBe(before!.isEnabled ? 1 : 0);
    }
    // Sessions are NOT stored in SQLite: only a reference session_key column, no secret blob.
    const sessionCols = db.prepare("PRAGMA table_info('accounts')").all() as { name: string; type: string }[];
    const sessionRelated = sessionCols.filter((c) => /session/i.test(c.name));
    expect(sessionRelated.every((c) => c.name === 'session_key' && c.type === 'TEXT')).toBe(true);
    expect(sessionRelated.some((c) => /blob/i.test(c.type))).toBe(false);

    // Channels preserved by Telegram id; status remapped into operational vocabulary.
    const tgIds = new Set(
      (db.prepare('SELECT telegram_channel_id FROM channels').all() as { telegram_channel_id: string }[]).map(
        (r) => r.telegram_channel_id,
      ),
    );
    for (const id of preChannelTg) {
      expect(tgIds.has(id), `pre-existing channel ${id} must survive`).toBe(true);
    }
    for (const r of db.prepare('SELECT status FROM channels').all() as { status: string }[]) {
      expect(r.status).toBe('healthy');
    }

    // Assignments preserved by (account, channel) pair.
    const assignSet = new Set(
      (
        db.prepare('SELECT account_id, channel_id FROM account_channels').all() as {
          account_id: number;
          channel_id: number;
        }[]
      ).map((r) => `${r.account_id}:${r.channel_id}`),
    );
    for (const pair of preAssignPairs) {
      expect(assignSet.has(pair), `pre-existing assignment ${pair} must survive`).toBe(true);
    }
    for (const r of db.prepare('SELECT status FROM account_channels').all() as { status: string }[]) {
      expect(r.status).toBe('healthy');
    }

    // Migration 0013 detached the deprecated per-channel rule/log linkage (rows
    // preserved, channel reference cleared) — proof 0013 actually executed.
    expect(countRows(db, 'rules')).toBe(preRules);
    expect((db.prepare('SELECT COUNT(*) AS c FROM rules WHERE channel_id IS NOT NULL').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM logs WHERE channel_id IS NOT NULL').get() as { c: number }).c).toBe(0);

    expect(fkViolationCount(db)).toBe(0);
    db.close();
    service.close();
  });

  it('migration 0010 guard: channels survive even when rules/templates are absent', () => {
    const dbPath = buildV8Fixture();

    const db = new DatabaseSync(dbPath);
    const channelsBefore = countRows(db, 'channels');
    const assignmentsBefore = countRows(db, 'account_channels');
    db.exec('DELETE FROM automation_dispatches; DELETE FROM rules; DELETE FROM reply_templates;');
    db.close();

    const service = new DatabaseService(dbPath, stubLogger);
    service.initialize();

    const verify = openRead(dbPath);
    expect(getVersion(verify)).toBe(14);
    const channelsAfter = countRows(verify, 'channels');
    const assignmentsAfter = countRows(verify, 'account_channels');
    expect(channelsAfter).toBe(channelsBefore);
    expect(assignmentsAfter).toBe(assignmentsBefore);
    expect(fkViolationCount(verify)).toBe(0);
    verify.close();
    service.close();
  });

  it('idempotent: a second migration run preserves accounts, channels, assignments, dispatch history, and sync state', () => {
    const dbPath = buildV8Fixture();

    const first = new DatabaseService(dbPath, stubLogger);
    first.initialize();

    const afterFirst = openRead(dbPath);
    expect(getVersion(afterFirst)).toBe(14);
    const channelIds = (afterFirst.prepare('SELECT id FROM channels ORDER BY id').all() as { id: number }[]).map(
      (r) => r.id,
    ) as [number, number, number];
    const c0 = channelIds[0];
    const c1 = channelIds[1];
    afterFirst.close();

    // Seed sync-state rows now that telegram_channel_sync_state exists (created by 0009).
    const seed = new DatabaseSync(dbPath);
    seed.exec('PRAGMA foreign_keys = ON;');
    const insertSync = seed.prepare(
      `INSERT INTO telegram_channel_sync_state (account_id, channel_id, pts, sync_status, created_at, updated_at)
       VALUES (?, ?, 1, 'healthy', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    );
    insertSync.run(1, c0);
    insertSync.run(2, c1);
    seed.close();

    const snapshot = () => {
      const d = openRead(dbPath);
      const s = {
        version: getVersion(d),
        accounts: countRows(d, 'accounts'),
        channels: countRows(d, 'channels'),
        assignments: countRows(d, 'account_channels'),
        dispatches: countRows(d, 'automation_dispatches'),
        rules: countRows(d, 'rules'),
        templates: countRows(d, 'reply_templates'),
        logs: countRows(d, 'logs'),
        sync: countRows(d, 'telegram_channel_sync_state'),
      };
      d.close();
      return s;
    };

    const before = snapshot();

    const second = new DatabaseService(dbPath, stubLogger);
    second.initialize();

    const after = snapshot();
    expect(after.version).toBe(14);
    expect(after.accounts).toBe(before.accounts);
    expect(after.channels).toBe(before.channels);
    expect(after.assignments).toBe(before.assignments);
    expect(after.dispatches).toBe(before.dispatches);
    expect(after.rules).toBe(before.rules);
    expect(after.templates).toBe(before.templates);
    expect(after.logs).toBe(before.logs);
    expect(after.sync).toBe(before.sync);
    console.log('[migration-safety] idempotent re-run preserved all rows; version =', after.version);

    const finalDb = openRead(dbPath);
    expect(fkViolationCount(finalDb)).toBe(0);
    finalDb.close();
    second.close();
    first.close();
  });

  it('zero-channel database: migrations succeed without deleting unrelated data', () => {
    const dbPath = buildV8Fixture();

    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON;');
    const ownersBefore = countRows(db, 'owners');
    const accountsBefore = countRows(db, 'accounts');
    // Cascades account_channels + automation_dispatches; rules/logs channel_id -> NULL.
    db.exec('DELETE FROM channels;');
    db.close();

    const service = new DatabaseService(dbPath, stubLogger);
    service.initialize();

    const verify = openRead(dbPath);
    expect(getVersion(verify)).toBe(14);
    expect(countRows(verify, 'channels')).toBe(0);
    expect(countRows(verify, 'owners')).toBe(ownersBefore);
    expect(countRows(verify, 'accounts')).toBe(accountsBefore);
    expect(fkViolationCount(verify)).toBe(0);
    verify.close();
    service.close();
  });

  it('migration 0013 directly preserves sync state, channels, assignments, and dispatch history', () => {
    const dbPath = buildV8Fixture();

    // Bring the database to v14 so production tables (incl. sync state) exist.
    const initial = new DatabaseService(dbPath, stubLogger);
    initial.initialize();
    initial.close();

    const db = new DatabaseSync(dbPath);

    // Add extra production-shaped rows that must survive a re-run of migration 0013.
    const chanInfo = db
      .prepare(
        `INSERT INTO channels (telegram_channel_id, username, title, is_enabled, status)
         VALUES (?, ?, ?, 1, 'healthy')`,
      )
      .run('999000111', 'extra', 'Extra Channel');
    const extraChan = Number(chanInfo.lastInsertRowid);
    db.prepare(
      `INSERT INTO account_channels (account_id, channel_id, is_enabled, status)
       VALUES (1, ?, 1, 'healthy')`,
    ).run(extraChan);
    db.prepare(
      `INSERT INTO telegram_channel_sync_state (account_id, channel_id, pts, sync_status, created_at, updated_at)
       VALUES (1, ?, 1, 'healthy', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    ).run(extraChan);
    db.prepare(
      `INSERT INTO automation_dispatches (account_id, channel_id, reply_template_id, source_message_id, matched_trigger, delay_ms, status)
       VALUES (1, ?, NULL, 42, 'keyword', 1000, 'sent')`,
    ).run(extraChan);

    const before = {
      channels: countRows(db, 'channels'),
      assignments: countRows(db, 'account_channels'),
      dispatches: countRows(db, 'automation_dispatches'),
      sync: countRows(db, 'telegram_channel_sync_state'),
      identity: countRows(db, 'channel_identity_history'),
    };

    // Re-run 0013 directly (idempotent by construction) to prove it no longer deletes these tables.
    db.exec('PRAGMA foreign_keys = OFF;');
    rebuildChannelSchemaMigration.up(db);
    db.exec('PRAGMA foreign_keys = ON;');

    const after = {
      channels: countRows(db, 'channels'),
      assignments: countRows(db, 'account_channels'),
      dispatches: countRows(db, 'automation_dispatches'),
      sync: countRows(db, 'telegram_channel_sync_state'),
      identity: countRows(db, 'channel_identity_history'),
    };

    expect(after.channels).toBe(before.channels);
    expect(after.assignments).toBe(before.assignments);
    expect(after.dispatches).toBe(before.dispatches);
    expect(after.sync).toBe(before.sync);
    expect(after.identity).toBe(before.identity);
    expect(fkViolationCount(db)).toBe(0);
    db.close();
  });
});
