import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterAll, describe, expect, it } from 'vitest';

import { DatabaseService, FOUNDATION_TABLES } from '../src/database/database.service.js';
import { rebuildChannelSchemaMigration } from '../src/database/migrations/0013-rebuild-channel-schema.js';
import type { AppLogger } from '../src/logging/logger.js';

const stubLogger = new Proxy({}, { get: () => () => {} }) as unknown as AppLogger;

const REAL_DB_PATH = path.resolve(process.cwd(), 'data', 'auto-wtb.sqlite');

const NEW_CHANNEL_TG_IDS = [
  '1611324665',
  '1303979309',
  '1441823150',
  '1202510480',
  '1274048263',
  '4436049182',
  '1525948158',
];

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

function copySqlite(src: string, dest: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const file = src + suffix;
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, dest + suffix);
    }
  }
}

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

function openRead(p: string): DatabaseSync {
  return new DatabaseSync(p, { readOnly: true });
}

function requireRealV8(): string {
  if (!fs.existsSync(REAL_DB_PATH)) {
    throw new Error(`Real v8 database not found at ${REAL_DB_PATH}; cannot run production migration test`);
  }
  const dbPath = makeTempDb();
  copySqlite(REAL_DB_PATH, dbPath);
  const probe = new DatabaseSync(dbPath);
  const version = getVersion(probe);
  if (version !== 8) {
    probe.close();
    throw new Error(`Real database is at v${version}, expected v8; skipping to avoid wrong fixture`);
  }
  probe.close();
  return dbPath;
}

// Augment a copied v8 database into a production-shaped dataset:
// 8 channels (1 existing + 7 new), 17 assignments (3 existing + 14 new),
// sync state for the new assignments, keeping all existing dispatches/rules/templates.
function augmentToProductionShape(dbPath: string): void {
  const db = new DatabaseSync(dbPath);

  const insertChannel = db.prepare(
    `INSERT INTO channels (telegram_channel_id, username, title, is_enabled, status, created_at, updated_at)
     VALUES (?, ?, ?, 1, 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
  );
  const insertAssign = db.prepare(
    `INSERT OR IGNORE INTO account_channels (account_id, channel_id, is_enabled, status, created_at, updated_at)
     VALUES (?, ?, 1, 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
  );

  for (const tgId of NEW_CHANNEL_TG_IDS) {
    const info = insertChannel.run(tgId, `chan_${tgId}`, `Channel ${tgId}`);
    const channelId = Number(info.lastInsertRowid);
    insertAssign.run(1, channelId);
    insertAssign.run(2, channelId);
  }

  db.close();
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

  it('production v8 database: channels, assignments, sync state, and dispatch history survive 9-14', () => {
    const dbPath = requireRealV8();

    const pre = new DatabaseSync(dbPath);
    const preChannelIds = new Set(
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
    const preDispatchCount = (pre.prepare('SELECT COUNT(*) AS c FROM automation_dispatches').get() as { c: number }).c;
    const preRuleCount = (pre.prepare('SELECT COUNT(*) AS c FROM rules').get() as { c: number }).c;
    const preTemplateCount = (pre.prepare('SELECT COUNT(*) AS c FROM reply_templates').get() as { c: number }).c;
    pre.close();

    augmentToProductionShape(dbPath);

    const service = new DatabaseService(dbPath, stubLogger);
    service.initialize();

    const db = openRead(dbPath);
    expect(getVersion(db)).toBe(14);

    const channelRows = db
      .prepare('SELECT id, telegram_channel_id, status FROM channels ORDER BY id')
      .all() as { id: number; telegram_channel_id: string; status: string }[];
    expect(channelRows.length).toBe(8);

    const tgIds = new Set(channelRows.map((r) => r.telegram_channel_id));
    for (const id of preChannelIds) {
      expect(tgIds.has(id), `pre-existing channel ${id} must survive`).toBe(true);
    }
    for (const id of NEW_CHANNEL_TG_IDS) {
      expect(tgIds.has(id), `augmented channel ${id} must survive`).toBe(true);
    }
    for (const r of channelRows) {
      expect(r.status).toBe('healthy');
    }

    const assignRows = db
      .prepare('SELECT account_id, channel_id, status FROM account_channels')
      .all() as { account_id: number; channel_id: number; status: string }[];
    expect(assignRows.length).toBe(17);

    const idByTg = new Map(channelRows.map((r) => [r.telegram_channel_id, r.id]));
    const assignSet = new Set(assignRows.map((r) => `${r.account_id}:${r.channel_id}`));
    for (const pair of preAssignPairs) {
      expect(assignSet.has(pair), `pre-existing assignment ${pair} must survive`).toBe(true);
    }
    for (const tgId of NEW_CHANNEL_TG_IDS) {
      const channelId = idByTg.get(tgId);
      expect(assignSet.has(`1:${channelId}`), `assignment account 1 / ${tgId} must survive`).toBe(true);
      expect(assignSet.has(`2:${channelId}`), `assignment account 2 / ${tgId} must survive`).toBe(true);
    }
    for (const r of assignRows) {
      expect(r.status).toBe('healthy');
    }

    const dispatchCount = (db.prepare('SELECT COUNT(*) AS c FROM automation_dispatches').get() as { c: number }).c;
    expect(dispatchCount).toBe(preDispatchCount);

    const syncTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'telegram_channel_sync_state'")
      .get();
    expect(syncTable, 'telegram_channel_sync_state must be created by migration 0009').toBeTruthy();
    const syncCount = (
      db.prepare('SELECT COUNT(*) AS c FROM telegram_channel_sync_state').get() as { c: number }
    ).c;
    expect(syncCount).toBe(0);

    const ruleCount = (db.prepare('SELECT COUNT(*) AS c FROM rules').get() as { c: number }).c;
    expect(ruleCount).toBe(preRuleCount);
    const templateCount = (db.prepare('SELECT COUNT(*) AS c FROM reply_templates').get() as { c: number }).c;
    expect(templateCount).toBe(preTemplateCount);

    expect(fkViolationCount(db)).toBe(0);
    db.close();
    service.close();
  });

  it('migration 0010 guard: channels survive even when rules/templates are absent', () => {
    const dbPath = requireRealV8();

    const db = new DatabaseSync(dbPath);
    const channelsBefore = (db.prepare('SELECT COUNT(*) AS c FROM channels').get() as { c: number }).c;
    const assignmentsBefore = (db.prepare('SELECT COUNT(*) AS c FROM account_channels').get() as { c: number }).c;
    db.exec('DELETE FROM automation_dispatches; DELETE FROM rules; DELETE FROM reply_templates;');
    db.close();

    const service = new DatabaseService(dbPath, stubLogger);
    service.initialize();

    const verify = openRead(dbPath);
    expect(getVersion(verify)).toBe(14);
    const channelsAfter = (verify.prepare('SELECT COUNT(*) AS c FROM channels').get() as { c: number }).c;
    const assignmentsAfter = (verify.prepare('SELECT COUNT(*) AS c FROM account_channels').get() as { c: number }).c;
    expect(channelsAfter).toBe(channelsBefore);
    expect(assignmentsAfter).toBe(assignmentsBefore);
    expect(fkViolationCount(verify)).toBe(0);
    verify.close();
    service.close();
  });

  it('idempotent: running migrations a second time does not delete production data', () => {
    const dbPath = requireRealV8();
    augmentToProductionShape(dbPath);

    const first = new DatabaseService(dbPath, stubLogger);
    first.initialize();

    const before = openRead(dbPath);
    const channelsBefore = (before.prepare('SELECT COUNT(*) AS c FROM channels').get() as { c: number }).c;
    const assignmentsBefore = (before.prepare('SELECT COUNT(*) AS c FROM account_channels').get() as { c: number }).c;
    before.close();

    const second = new DatabaseService(dbPath, stubLogger);
    second.initialize();

    const after = openRead(dbPath);
    expect(getVersion(after)).toBe(14);
    const channelsAfter = (after.prepare('SELECT COUNT(*) AS c FROM channels').get() as { c: number }).c;
    const assignmentsAfter = (after.prepare('SELECT COUNT(*) AS c FROM account_channels').get() as { c: number }).c;
    expect(channelsAfter).toBe(channelsBefore);
    expect(assignmentsAfter).toBe(assignmentsBefore);
    expect(fkViolationCount(after)).toBe(0);
    after.close();
    second.close();
    first.close();
  });

  it('zero-channel database: migrations succeed without deleting unrelated data', () => {
    const dbPath = requireRealV8();

    const db = new DatabaseSync(dbPath);
    const ownersBefore = (db.prepare('SELECT COUNT(*) AS c FROM owners').get() as { c: number }).c;
    const accountsBefore = (db.prepare('SELECT COUNT(*) AS c FROM accounts').get() as { c: number }).c;
    // At v8, telegram_channel_sync_state does not exist yet (created by migration 0009),
    // so only delete the tables that are present.
    const existing = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    db.exec('PRAGMA foreign_keys = OFF;');
    // Detach channel-scoped references before removing channel rows so the
    // database stays referentially consistent for the migration FK checks.
    if (existing.includes('rules')) {
      db.exec('UPDATE rules SET channel_id = NULL WHERE channel_id IS NOT NULL');
    }
    if (existing.includes('logs')) {
      db.exec('UPDATE logs SET channel_id = NULL WHERE channel_id IS NOT NULL');
    }
    const clearables = ['automation_dispatches', 'telegram_channel_sync_state', 'account_channels', 'channels'].filter(
      (t) => existing.includes(t),
    );
    for (const table of clearables) {
      db.exec(`DELETE FROM ${table}`);
    }
    db.exec('PRAGMA foreign_keys = ON;');
    db.close();

    const service = new DatabaseService(dbPath, stubLogger);
    service.initialize();

    const verify = openRead(dbPath);
    expect(getVersion(verify)).toBe(14);
    const channelsAfter = (verify.prepare('SELECT COUNT(*) AS c FROM channels').get() as { c: number }).c;
    expect(channelsAfter).toBe(0);
    const ownersAfter = (verify.prepare('SELECT COUNT(*) AS c FROM owners').get() as { c: number }).c;
    const accountsAfter = (verify.prepare('SELECT COUNT(*) AS c FROM accounts').get() as { c: number }).c;
    expect(ownersAfter).toBe(ownersBefore);
    expect(accountsAfter).toBe(accountsBefore);
    expect(fkViolationCount(verify)).toBe(0);
    verify.close();
    service.close();
  });

  it('migration 0013 directly preserves sync state, channels, assignments, and dispatch history', () => {
    const dbPath = requireRealV8();

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
      `INSERT INTO telegram_channel_sync_state (channel_id, account_id, pts, sync_status, created_at, updated_at)
       VALUES (?, 1, 5, 'healthy', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    ).run(extraChan);
    db.prepare(
      `INSERT INTO automation_dispatches (account_id, channel_id, source_message_id, matched_trigger, delay_ms, status)
       VALUES (1, ?, 42, 'keyword', 1000, 'sent')`,
    ).run(extraChan);

    const before = {
      channels: (db.prepare('SELECT COUNT(*) AS c FROM channels').get() as { c: number }).c,
      assignments: (db.prepare('SELECT COUNT(*) AS c FROM account_channels').get() as { c: number }).c,
      dispatches: (db.prepare('SELECT COUNT(*) AS c FROM automation_dispatches').get() as { c: number }).c,
      sync: (db.prepare('SELECT COUNT(*) AS c FROM telegram_channel_sync_state').get() as { c: number }).c,
      identity: (db.prepare('SELECT COUNT(*) AS c FROM channel_identity_history').get() as { c: number }).c,
    };

    // Re-run 0013 directly (it is idempotent by construction) to prove it no
    // longer deletes these tables.
    db.exec('PRAGMA foreign_keys = OFF;');
    rebuildChannelSchemaMigration.up(db);
    db.exec('PRAGMA foreign_keys = ON;');

    const after = {
      channels: (db.prepare('SELECT COUNT(*) AS c FROM channels').get() as { c: number }).c,
      assignments: (db.prepare('SELECT COUNT(*) AS c FROM account_channels').get() as { c: number }).c,
      dispatches: (db.prepare('SELECT COUNT(*) AS c FROM automation_dispatches').get() as { c: number }).c,
      sync: (db.prepare('SELECT COUNT(*) AS c FROM telegram_channel_sync_state').get() as { c: number }).c,
      identity: (db.prepare('SELECT COUNT(*) AS c FROM channel_identity_history').get() as { c: number }).c,
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
