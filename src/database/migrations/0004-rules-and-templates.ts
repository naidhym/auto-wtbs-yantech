import type { Migration } from './types.js';

export const rulesAndTemplatesMigration: Migration = {
  version: 4,
  name: 'owner_rules_and_templates',
  foreignKeysDisabled: true,
  up(database): void {
    database.exec(`
      CREATE TABLE reply_templates_m4 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        body TEXT NOT NULL,
        is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (owner_id, name),
        FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE
      );

      WITH ranked_templates AS (
        SELECT
          rt.*,
          a.owner_id,
          ROW_NUMBER() OVER (
            PARTITION BY a.owner_id, rt.name COLLATE NOCASE ORDER BY rt.id
          ) AS duplicate_number
        FROM reply_templates rt
        JOIN accounts a ON a.id = rt.account_id
      )
      INSERT INTO reply_templates_m4 (
        id, owner_id, name, body, is_enabled, created_at, updated_at
      )
      SELECT
        id,
        owner_id,
        CASE
          WHEN duplicate_number = 1 THEN name
          ELSE name || ' [legacy ' || id || ']'
        END,
        body,
        is_active,
        created_at,
        updated_at
      FROM ranked_templates;

      CREATE TABLE rules_m4 (
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
        FOREIGN KEY (reply_template_id) REFERENCES reply_templates_m4(id) ON DELETE SET NULL
      );

      WITH ranked_rules AS (
        SELECT
          r.*,
          a.owner_id,
          ROW_NUMBER() OVER (
            PARTITION BY a.owner_id, r.name COLLATE NOCASE ORDER BY r.id
          ) AS duplicate_number
        FROM rules r
        JOIN accounts a ON a.id = r.account_id
      )
      INSERT INTO rules_m4 (
        id,
        owner_id,
        channel_id,
        reply_template_id,
        name,
        trigger_keywords,
        exclude_keywords,
        cleanup_sender_patterns,
        is_enabled,
        created_at,
        updated_at
      )
      SELECT
        id,
        owner_id,
        channel_id,
        reply_template_id,
        CASE
          WHEN duplicate_number = 1 THEN name
          ELSE name || ' [legacy ' || id || ']'
        END,
        trigger_keywords,
        exclude_keywords,
        '["JGN REPLY"]',
        is_enabled,
        created_at,
        updated_at
      FROM ranked_rules;

      DROP TABLE rules;
      DROP TABLE reply_templates;
      ALTER TABLE reply_templates_m4 RENAME TO reply_templates;
      ALTER TABLE rules_m4 RENAME TO rules;

      CREATE INDEX idx_reply_templates_owner_id ON reply_templates(owner_id);
      CREATE INDEX idx_rules_owner_id ON rules(owner_id);
      CREATE INDEX idx_rules_channel_id ON rules(channel_id);
      CREATE INDEX idx_rules_enabled_channel ON rules(is_enabled, channel_id);
    `);
  },
};
