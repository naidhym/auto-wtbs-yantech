import type { Migration } from './types.js';

export const foundationMigration: Migration = {
  version: 1,
  name: 'foundation_schema',
  up(database): void {
    database.exec(`
      CREATE TABLE owners (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_user_id TEXT NOT NULL UNIQUE,
        is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id INTEGER NOT NULL,
        label TEXT NOT NULL,
        telegram_user_id TEXT UNIQUE,
        session_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'disconnected'
          CHECK (status IN ('disabled', 'disconnected', 'connecting', 'connected', 'reconnecting', 'error')),
        is_enabled INTEGER NOT NULL DEFAULT 0 CHECK (is_enabled IN (0, 1)),
        last_connected_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE RESTRICT
      );

      CREATE TABLE channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        telegram_channel_id TEXT NOT NULL,
        username TEXT,
        title TEXT,
        is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (account_id, telegram_channel_id),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );

      CREATE TABLE reply_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        body TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (account_id, name),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );

      CREATE TABLE rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        channel_id INTEGER,
        reply_template_id INTEGER,
        name TEXT NOT NULL,
        trigger_keywords TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(trigger_keywords)),
        exclude_keywords TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(exclude_keywords)),
        is_enabled INTEGER NOT NULL DEFAULT 0 CHECK (is_enabled IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (account_id, name),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
        FOREIGN KEY (reply_template_id) REFERENCES reply_templates(id) ON DELETE SET NULL
      );

      CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
        event_type TEXT NOT NULL,
        account_id INTEGER,
        channel_id INTEGER,
        rule_id INTEGER,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        error_reason TEXT,
        exclude_keyword TEXT,
        message TEXT,
        metadata TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL,
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL,
        FOREIGN KEY (rule_id) REFERENCES rules(id) ON DELETE SET NULL
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL CHECK (json_valid(value)),
        description TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE INDEX idx_accounts_owner_id ON accounts(owner_id);
      CREATE INDEX idx_channels_account_id ON channels(account_id);
      CREATE INDEX idx_rules_account_id ON rules(account_id);
      CREATE INDEX idx_rules_channel_id ON rules(channel_id);
      CREATE INDEX idx_logs_account_created_at ON logs(account_id, created_at DESC);
      CREATE INDEX idx_logs_created_at ON logs(created_at DESC);
    `);
  },
};
