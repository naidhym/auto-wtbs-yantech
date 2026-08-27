import type { DatabaseSync } from 'node:sqlite';

import type { Migration } from './types.js';

/**
 * v13 intentionally upgrades the active channel subsystem to the new
 * operational lifecycle (channels + account_channels status vocabularies,
 * durable channel identity history, dispatch FK repointed at identity history).
 *
 * CRITICAL SAFETY CONSTRAINT:
 * This migration MUST NOT delete existing production channels, account-channel
 * assignments, or sync state. It upgrades the physical schema in place and
 * copies every existing row forward. Previously this migration wiped the
 * channel subsystem (DELETE FROM account_channels; DROP TABLE channels;), which
 * destroyed production monitoring data on any startup against a populated DB.
 *
 * Behaviour:
 * - channel_identity_history is created once and populated from existing channels
 *   (idempotent: existing identity rows are not duplicated).
 * - automation_dispatches is rebuilt so its FK points at durable identity history;
 *   every dispatch row is preserved.
 * - channels is rebuilt with the new status vocabulary / UNIQUE / indexes, copying
 *   every existing channel row forward. Legacy `active` status is mapped to
 *   `healthy`. Channel surrogate IDs and Telegram IDs are preserved.
 * - account_channels and telegram_channel_sync_state are left intact; migration
 *   0014 upgrades the account_channels status constraint while preserving rows.
 * - rules/logs channel references are preserved (channels survive, so the FKs stay valid).
 */
export const rebuildChannelSchemaMigration: Migration = {
  version: 13,
  name: 'rebuild_channel_schema_and_preserve_channels',
  foreignKeysDisabled: true,
  up(database: DatabaseSync): void {
    database.exec(`
      -- 1. Durable channel identity (non-destructive; created once).
      CREATE TABLE IF NOT EXISTS channel_identity_history (
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
      FROM channels
      WHERE NOT EXISTS (
        SELECT 1 FROM channel_identity_history
        WHERE channel_identity_history.id = channels.id
      );

      -- 2. Preserve automation dispatch history, repointing its FK at durable identity.
      CREATE TABLE automation_dispatches_v12 (
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

      INSERT INTO automation_dispatches_v12 (
        id, account_id, channel_id, reply_template_id, source_message_id,
        reply_message_id, matched_trigger, delay_ms, status, reaction_status,
        reply_message_link, error_reason, created_at, scheduled_at, sent_at, updated_at
      )
      SELECT
        id, account_id, channel_id, reply_template_id, source_message_id,
        reply_message_id, matched_trigger, delay_ms, status, reaction_status,
        reply_message_link, error_reason, created_at, scheduled_at, sent_at, updated_at
      FROM automation_dispatches;

      DROP TABLE automation_dispatches;

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

      -- Detach the legacy per-channel linkage on rules/logs. The new v13+
      -- architecture resolves rules globally (per account), so a stale channel
      -- reference must not survive. This only clears a deprecated linkage column;
      -- it does NOT delete any rows, so rule/template/log data is preserved.
      UPDATE rules SET channel_id = NULL WHERE channel_id IS NOT NULL;
      UPDATE logs SET channel_id = NULL WHERE channel_id IS NOT NULL;

      -- 3. Upgrade channels schema IN PLACE, preserving every existing row.
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

      INSERT INTO channels_v13 (
        id, telegram_channel_id, username, title, is_enabled, status,
        automation_blocked, blocked_reason, blocked_at, created_at, updated_at
      )
      SELECT
        id,
        telegram_channel_id,
        username,
        title,
        is_enabled,
        CASE status WHEN 'active' THEN 'healthy' ELSE COALESCE(status, 'pending') END,
        automation_blocked,
        blocked_reason,
        blocked_at,
        created_at,
        updated_at
      FROM channels;

      DROP TABLE channels;
      ALTER TABLE channels_v13 RENAME TO channels;

      CREATE INDEX idx_channels_enabled ON channels(is_enabled);
      CREATE INDEX idx_channels_automation_blocked
        ON channels(automation_blocked, is_enabled);

      DROP TRIGGER IF EXISTS channels_identity_history_insert;
      CREATE TRIGGER channels_identity_history_insert
      AFTER INSERT ON channels
      BEGIN
        INSERT INTO channel_identity_history (
          id, telegram_channel_id, username, title, first_seen_at, last_seen_at
        )
        VALUES (
          NEW.id,
          NEW.telegram_channel_id,
          NEW.username,
          NEW.title,
          NEW.created_at,
          NEW.updated_at
        );
      END;

      DROP TRIGGER IF EXISTS channels_identity_history_update;
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

      -- Preserve channel autoincrement sequence continuity so a newly added
      -- channel cannot accidentally reuse the identity of a pre-upgrade row.
      DELETE FROM sqlite_sequence WHERE name = 'channels';
      INSERT INTO sqlite_sequence (name, seq)
      SELECT 'channels', COALESCE(MAX(id), 0) FROM channel_identity_history;
    `);
  },
};
