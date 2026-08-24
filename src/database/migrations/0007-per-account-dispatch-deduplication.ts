import type { Migration } from './types.js';

export const perAccountDispatchDeduplicationMigration: Migration = {
  version: 7,
  name: 'per_account_dispatch_deduplication',
  foreignKeysDisabled: true,
  up(database): void {
    database.exec(`
      ALTER TABLE automation_dispatches RENAME TO automation_dispatches_v6;

      CREATE TABLE automation_dispatches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        channel_id INTEGER NOT NULL,
        reply_template_id INTEGER,
        source_message_id INTEGER NOT NULL,
        reply_message_id INTEGER,
        matched_trigger TEXT NOT NULL,
        delay_ms INTEGER NOT NULL CHECK (delay_ms >= 0 AND delay_ms <= 600000),
        status TEXT NOT NULL
          CHECK (status IN ('scheduled', 'sent', 'failed', 'cooldown_skipped', 'limit_skipped')),
        reaction_status TEXT NOT NULL DEFAULT 'skipped'
          CHECK (reaction_status IN ('sent', 'skipped', 'failed')),
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

      INSERT INTO automation_dispatches (
        id, account_id, channel_id, reply_template_id, source_message_id,
        reply_message_id, matched_trigger, delay_ms, status, reaction_status,
        reply_message_link, error_reason, created_at, scheduled_at, sent_at, updated_at
      )
      SELECT
        id, account_id, channel_id, reply_template_id, source_message_id,
        reply_message_id, matched_trigger, delay_ms, status, reaction_status,
        reply_message_link, error_reason, created_at, scheduled_at, sent_at, updated_at
      FROM automation_dispatches_v6;

      DROP TABLE automation_dispatches_v6;

      CREATE INDEX idx_automation_dispatch_account_sent
        ON automation_dispatches(account_id, status, sent_at DESC);
      CREATE INDEX idx_automation_dispatch_channel_source
        ON automation_dispatches(channel_id, source_message_id);

      DELETE FROM settings WHERE key LIKE 'automation_dispatch_round_robin_channel_%';
    `);
  },
};
