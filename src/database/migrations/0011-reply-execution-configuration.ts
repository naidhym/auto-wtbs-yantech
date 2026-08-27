import type { Migration } from './types.js';

export const replyExecutionConfigurationMigration: Migration = {
  version: 11,
  name: 'reply_execution_configuration',
  foreignKeysDisabled: true,
  up(database): void {
    database.exec(`
      CREATE TABLE account_automation_settings_p4 (
        account_id INTEGER PRIMARY KEY,
        reply_delay_ms INTEGER NOT NULL DEFAULT 100
          CHECK (reply_delay_ms >= 100 AND reply_delay_ms <= 600000),
        auto_reaction INTEGER NOT NULL DEFAULT 0
          CHECK (auto_reaction IN (0, 1)),
        cooldown_ms INTEGER NOT NULL DEFAULT 0
          CHECK (cooldown_ms >= 0),
        hourly_limit INTEGER NOT NULL DEFAULT 0
          CHECK (hourly_limit >= 0),
        daily_limit INTEGER NOT NULL DEFAULT 0
          CHECK (daily_limit >= 0),
        notification_target TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );

      INSERT INTO account_automation_settings_p4 (
        account_id, reply_delay_ms, auto_reaction, cooldown_ms, hourly_limit,
        daily_limit, notification_target, created_at, updated_at
      )
      SELECT
        account_id,
        CASE WHEN reply_delay_ms < 100 THEN 100 ELSE reply_delay_ms END,
        auto_reaction,
        cooldown_ms,
        hourly_limit,
        daily_limit,
        notification_target,
        created_at,
        updated_at
      FROM account_automation_settings;

      DROP TABLE account_automation_settings;
      ALTER TABLE account_automation_settings_p4 RENAME TO account_automation_settings;

      UPDATE reply_templates
      SET is_enabled = 0
      WHERE is_enabled = 1
        AND id NOT IN (
          SELECT MIN(active.id)
          FROM reply_templates active
          WHERE active.is_enabled = 1
          GROUP BY active.account_id
        );

      UPDATE reply_templates
      SET is_enabled = 1
      WHERE id IN (
        SELECT MIN(candidate.id)
        FROM reply_templates candidate
        WHERE NOT EXISTS (
          SELECT 1 FROM reply_templates active
          WHERE active.account_id = candidate.account_id AND active.is_enabled = 1
        )
        GROUP BY candidate.account_id
      );

      CREATE UNIQUE INDEX idx_reply_templates_one_active_per_account
        ON reply_templates(account_id)
        WHERE is_enabled = 1;
    `);
  },
};
