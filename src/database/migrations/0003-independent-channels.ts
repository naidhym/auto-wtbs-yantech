import type { Migration } from './types.js';

export const independentChannelsMigration: Migration = {
  version: 3,
  name: 'independent_channels',
  foreignKeysDisabled: true,
  up(database): void {
    database.exec(`
      CREATE TABLE channels_m3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_channel_id TEXT NOT NULL UNIQUE,
        username TEXT,
        title TEXT NOT NULL,
        is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'resolving', 'syncing', 'healthy', 'degraded', 'error', 'disabled', 'disconnected')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      INSERT INTO channels_m3 (
        id, telegram_channel_id, username, title, is_enabled, status, created_at, updated_at
      )
      SELECT
        MIN(id),
        telegram_channel_id,
        MAX(username),
        COALESCE(MAX(title), MAX(username), telegram_channel_id),
        MAX(is_active),
        CASE WHEN MAX(is_active) = 1 THEN 'healthy' ELSE 'disabled' END,
        MIN(created_at),
        MAX(updated_at)
      FROM channels
      GROUP BY telegram_channel_id;

      CREATE TABLE account_channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        channel_id INTEGER NOT NULL,
        is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'resolving', 'syncing', 'healthy', 'degraded', 'error', 'disabled', 'disconnected')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (account_id, channel_id),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
        FOREIGN KEY (channel_id) REFERENCES channels_m3(id) ON DELETE CASCADE
      );

      INSERT INTO account_channels (
        account_id, channel_id, is_enabled, status, created_at, updated_at
      )
      SELECT
        legacy.account_id,
        canonical.id,
        legacy.is_active,
        CASE WHEN legacy.is_active = 1 THEN 'healthy' ELSE 'disabled' END,
        legacy.created_at,
        legacy.updated_at
      FROM channels AS legacy
      JOIN channels_m3 AS canonical
        ON canonical.telegram_channel_id = legacy.telegram_channel_id;

      UPDATE rules
      SET channel_id = (
        SELECT canonical.id
        FROM channels AS legacy
        JOIN channels_m3 AS canonical
          ON canonical.telegram_channel_id = legacy.telegram_channel_id
        WHERE legacy.id = rules.channel_id
      )
      WHERE channel_id IS NOT NULL;

      UPDATE logs
      SET channel_id = (
        SELECT canonical.id
        FROM channels AS legacy
        JOIN channels_m3 AS canonical
          ON canonical.telegram_channel_id = legacy.telegram_channel_id
        WHERE legacy.id = logs.channel_id
      )
      WHERE channel_id IS NOT NULL;

      DROP TABLE channels;
      ALTER TABLE channels_m3 RENAME TO channels;

      CREATE INDEX idx_channels_enabled ON channels(is_enabled);
      CREATE INDEX idx_account_channels_account_id ON account_channels(account_id);
      CREATE INDEX idx_account_channels_channel_id ON account_channels(channel_id);
      CREATE INDEX idx_account_channels_effective
        ON account_channels(account_id, channel_id, is_enabled);
    `);
  },
};
