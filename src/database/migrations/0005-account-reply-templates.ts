import type { Migration } from './types.js';

export const accountReplyTemplatesMigration: Migration = {
  version: 5,
  name: 'account_reply_templates',
  foreignKeysDisabled: true,
  up(database): void {
    const orphaned = database.prepare(`
      SELECT COUNT(*) AS count
      FROM reply_templates rt
      WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.owner_id = rt.owner_id)
    `).get() as { count: number };
    if (orphaned.count > 0) {
      throw new Error(
        'Account-scoped template migration requires at least one account for every template owner',
      );
    }

    database.exec(`
      CREATE TABLE reply_templates_m5 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        body TEXT NOT NULL,
        is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (account_id, name),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );

      INSERT INTO reply_templates_m5 (
        id, account_id, name, body, is_enabled, created_at, updated_at
      )
      SELECT
        rt.id,
        MIN(a.id),
        rt.name,
        rt.body,
        rt.is_enabled,
        rt.created_at,
        rt.updated_at
      FROM reply_templates rt
      JOIN accounts a ON a.owner_id = rt.owner_id
      GROUP BY rt.id;

      INSERT INTO reply_templates_m5 (
        account_id, name, body, is_enabled, created_at, updated_at
      )
      SELECT
        a.id,
        rt.name,
        rt.body,
        rt.is_enabled,
        rt.created_at,
        rt.updated_at
      FROM reply_templates rt
      JOIN accounts a ON a.owner_id = rt.owner_id
      WHERE a.id <> (
        SELECT MIN(owner_account.id)
        FROM accounts owner_account
        WHERE owner_account.owner_id = rt.owner_id
      );

      CREATE TABLE rules_m5 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id INTEGER NOT NULL,
        channel_id INTEGER,
        reply_template_id INTEGER,
        name TEXT NOT NULL,
        trigger_keywords TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(trigger_keywords)),
        exclude_keywords TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(exclude_keywords)),
        cleanup_sender_patterns TEXT NOT NULL DEFAULT '["JGN REPLY"]'
          CHECK (json_valid(cleanup_sender_patterns)),
        is_enabled INTEGER NOT NULL DEFAULT 0 CHECK (is_enabled IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (owner_id, name),
        FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE,
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
        FOREIGN KEY (reply_template_id) REFERENCES reply_templates_m5(id) ON DELETE SET NULL
      );

      INSERT INTO rules_m5 (
        id, owner_id, channel_id, reply_template_id, name, trigger_keywords,
        exclude_keywords, cleanup_sender_patterns, is_enabled, created_at, updated_at
      )
      SELECT
        r.id,
        r.owner_id,
        r.channel_id,
        CASE
          WHEN r.reply_template_id IS NULL THEN NULL
          ELSE (
            SELECT migrated.id
            FROM reply_templates_m5 migrated
            JOIN reply_templates legacy ON legacy.id = r.reply_template_id
            WHERE migrated.name = legacy.name
              AND migrated.account_id = COALESCE(
                (
                  SELECT MIN(ac.account_id)
                  FROM account_channels ac
                  JOIN accounts assigned ON assigned.id = ac.account_id
                  WHERE ac.channel_id = r.channel_id
                    AND assigned.owner_id = r.owner_id
                ),
                (
                  SELECT MIN(owner_account.id)
                  FROM accounts owner_account
                  WHERE owner_account.owner_id = r.owner_id
                )
              )
            LIMIT 1
          )
        END,
        r.name,
        r.trigger_keywords,
        r.exclude_keywords,
        r.cleanup_sender_patterns,
        r.is_enabled,
        r.created_at,
        r.updated_at
      FROM rules r;

      DROP TABLE rules;
      DROP TABLE reply_templates;
      ALTER TABLE reply_templates_m5 RENAME TO reply_templates;
      ALTER TABLE rules_m5 RENAME TO rules;

      CREATE INDEX idx_reply_templates_account_id ON reply_templates(account_id);
      CREATE INDEX idx_rules_owner_id ON rules(owner_id);
      CREATE INDEX idx_rules_channel_id ON rules(channel_id);
      CREATE INDEX idx_rules_enabled_channel ON rules(is_enabled, channel_id);
    `);
  },
};
