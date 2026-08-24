import type { Migration } from './types.js';

export const autoReplySafetyMigration: Migration = {
  version: 6,
  name: 'auto_reply_safety',
  up(database): void {
    database.exec(`
      ALTER TABLE channels ADD COLUMN automation_blocked INTEGER NOT NULL DEFAULT 0
        CHECK (automation_blocked IN (0, 1));
      ALTER TABLE channels ADD COLUMN blocked_reason TEXT;
      ALTER TABLE channels ADD COLUMN blocked_at TEXT;

      CREATE TABLE account_automation_settings (
        account_id INTEGER PRIMARY KEY,
        reply_delay_ms INTEGER NOT NULL DEFAULT 0
          CHECK (reply_delay_ms >= 0 AND reply_delay_ms <= 600000),
        auto_reaction INTEGER NOT NULL DEFAULT 0
          CHECK (auto_reaction IN (0, 1)),
        cooldown_ms INTEGER NOT NULL DEFAULT 0
          CHECK (cooldown_ms >= 0),
        hourly_limit INTEGER NOT NULL DEFAULT 0
          CHECK (hourly_limit >= 0),
        daily_limit INTEGER NOT NULL DEFAULT 0
          CHECK (daily_limit >= 0),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );

      INSERT INTO account_automation_settings (account_id)
      SELECT id FROM accounts;

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
        UNIQUE (channel_id, source_message_id),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
        FOREIGN KEY (reply_template_id) REFERENCES reply_templates(id) ON DELETE SET NULL
      );

      CREATE INDEX idx_automation_dispatch_account_sent
        ON automation_dispatches(account_id, status, sent_at DESC);
      CREATE INDEX idx_automation_dispatch_channel_source
        ON automation_dispatches(channel_id, source_message_id);
      CREATE INDEX idx_channels_automation_blocked
        ON channels(automation_blocked, is_enabled);

      INSERT OR IGNORE INTO settings (key, value, description)
      VALUES (
        'global_automation_enabled',
        'true',
        'Persistent emergency STOP/RESUME state for M5 auto reply execution'
      );
    `);
  },
};
