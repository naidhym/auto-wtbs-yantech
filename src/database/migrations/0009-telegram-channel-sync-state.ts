import type { DatabaseSync } from 'node:sqlite';

import type { Migration } from './types.js';

export const telegramChannelSyncStateMigration: Migration = {
  version: 9,
  name: 'telegram-channel-sync-state',
  up(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE telegram_channel_sync_state (
        account_id INTEGER NOT NULL,
        channel_id INTEGER NOT NULL,
        pts INTEGER NOT NULL DEFAULT 1,
        sync_status TEXT NOT NULL DEFAULT 'pending',
        last_successful_sync_at TEXT,
        last_attempted_sync_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (account_id, channel_id),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_telegram_channel_sync_state_channel
        ON telegram_channel_sync_state(channel_id, account_id);
    `);
  },
};
