import type { DatabaseSync } from 'node:sqlite';

import type { Migration } from './types.js';

/**
 * v13 intentionally reset the active channel subsystem (channels, account_channels,
 * telegram_channel_sync_state) to zero, but it only deleted rows from account_channels
 * and never rebuilt its schema. The physical CHECK constraint on account_channels.status
 * therefore stayed at the legacy contract (`active`, `disabled`, `error`, `inaccessible`)
 * on databases that were created before the operational-status redesign.
 *
 * The new runtime (ChannelRepository.assign / assignBulk / setAssignmentStatus*) writes
 * the domain `ChannelOperationalStatus` vocabulary, which the legacy CHECK rejects and
 * which surfaced as a "CHECK constraint failed" error when the first assignment was
 * created after a channel resolved + created.
 *
 * This migration rebuilds account_channels so its status CHECK matches the real domain
 * contract (`ChannelOperationalStatus`) while preserving columns, foreign keys, the
 * UNIQUE(account_id, channel_id) constraint, indexes and any existing assignment rows.
 * Legacy statuses are remapped to the nearest valid operational state.
 */
export const rebuildAccountChannelsStatusMigration: Migration = {
  version: 14,
  name: 'rebuild_account_channels_status_constraint',
  foreignKeysDisabled: true,
  up(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE account_channels_v14 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        channel_id INTEGER NOT NULL,
        is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN (
            'pending',
            'resolving',
            'syncing',
            'healthy',
            'degraded',
            'error',
            'disabled',
            'disconnected'
          )),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (account_id, channel_id),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
      );

      INSERT INTO account_channels_v14 (
        id, account_id, channel_id, is_enabled, status, created_at, updated_at
      )
      SELECT
        id,
        account_id,
        channel_id,
        is_enabled,
        CASE status
          WHEN 'active' THEN 'healthy'
          WHEN 'inaccessible' THEN 'error'
          ELSE status
        END,
        created_at,
        updated_at
      FROM account_channels;

      DROP TABLE account_channels;
      ALTER TABLE account_channels_v14 RENAME TO account_channels;

      CREATE INDEX idx_account_channels_account_id ON account_channels(account_id);
      CREATE INDEX idx_account_channels_channel_id ON account_channels(channel_id);
      CREATE INDEX idx_account_channels_effective
        ON account_channels(account_id, channel_id, is_enabled);
    `);
  },
};
