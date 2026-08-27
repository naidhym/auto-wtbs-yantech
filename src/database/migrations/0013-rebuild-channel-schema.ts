import type { DatabaseSync } from 'node:sqlite';

import type { Migration } from './types.js';

export const rebuildChannelSchemaMigration: Migration = {
  version: 13,
  name: 'rebuild_channel_schema_and_reset_channels',
  foreignKeysDisabled: true,
  up(database: DatabaseSync): void {
    database.exec(`
      -- Preserve immutable channel identity needed by historical dispatch rows.
      -- This table is not part of the active channel subsystem.
      CREATE TABLE channel_identity_history (
        id INTEGER PRIMARY KEY,
        telegram_channel_id TEXT NOT NULL,
        username TEXT,
        title TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      INSERT INTO channel_identity_history (
        id, telegram_channel_id, username, title, first_seen_at, last_seen_at
      )
      SELECT id, telegram_channel_id, username, title, created_at, updated_at
      FROM channels;

      -- Historical automation rows must survive the intentional active-channel reset.
      -- Keep the same runtime columns and strict FK integrity, but point channel identity
      -- at the durable history table instead of requiring an active channel row forever.
      ALTER TABLE automation_dispatches RENAME TO automation_dispatches_v12;

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
        FOREIGN KEY (channel_id) REFERENCES channel_identity_history(id) ON DELETE RESTRICT,
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
      FROM automation_dispatches_v12;

      DROP TABLE automation_dispatches_v12;

      CREATE INDEX idx_automation_dispatch_account_sent
        ON automation_dispatches(account_id, status, sent_at DESC);
      CREATE INDEX idx_automation_dispatch_channel_source
        ON automation_dispatches(channel_id, source_message_id);

      -- Global rules survive; legacy channel-scoped references are detached because the
      -- new architecture resolves rules globally. Log rows survive with their channel FK
      -- detached rather than being deleted with the active channel row.
      UPDATE rules SET channel_id = NULL WHERE channel_id IS NOT NULL;
      UPDATE logs SET channel_id = NULL WHERE channel_id IS NOT NULL;

      -- Intentional clean reset of only the active channel subsystem.
      DELETE FROM telegram_channel_sync_state;
      DELETE FROM account_channels;

      CREATE TABLE channels_v13 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_channel_id TEXT NOT NULL UNIQUE,
        username TEXT,
        title TEXT NOT NULL,
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
        automation_blocked INTEGER NOT NULL DEFAULT 0
          CHECK (automation_blocked IN (0, 1)),
        blocked_reason TEXT,
        blocked_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      DROP TABLE channels;
      ALTER TABLE channels_v13 RENAME TO channels;

      CREATE INDEX idx_channels_enabled ON channels(is_enabled);
      CREATE INDEX idx_channels_automation_blocked
        ON channels(automation_blocked, is_enabled);

      -- Keep future active channel IDs distinct from historical IDs so a newly added
      -- channel cannot accidentally reuse the identity of a pre-reset dispatch record.
      DELETE FROM sqlite_sequence WHERE name = 'channels';
      INSERT INTO sqlite_sequence (name, seq)
      SELECT 'channels', COALESCE(MAX(id), 0) FROM channel_identity_history;

      -- Every newly added active channel gets a durable identity before any dispatch can
      -- reference it. Deleting an active channel therefore never destroys dispatch history.
      CREATE TRIGGER channels_identity_history_insert
      AFTER INSERT ON channels
      BEGIN
        INSERT INTO channel_identity_history (
          id, telegram_channel_id, username, title, first_seen_at, last_seen_at
        ) VALUES (
          NEW.id,
          NEW.telegram_channel_id,
          NEW.username,
          NEW.title,
          NEW.created_at,
          NEW.updated_at
        );
      END;

      CREATE TRIGGER channels_identity_history_update
      AFTER UPDATE OF telegram_channel_id, username, title, updated_at ON channels
      BEGIN
        UPDATE channel_identity_history
        SET telegram_channel_id = NEW.telegram_channel_id,
            username = NEW.username,
            title = NEW.title,
            last_seen_at = NEW.updated_at
        WHERE id = NEW.id;
      END;
    `);
  },
};
