import type { DatabaseSync } from 'node:sqlite';

import type { Migration } from './types.js';

export const resetChannelsForRedesignMigration: Migration = {
  version: 10,
  name: 'reset-channels-for-redesign',
  up(database: DatabaseSync): void {
    // Only reset channels if this is a fresh database (no rules or templates yet).
    // This prevents wiping out legitimate test data or production data that was
    // migrated from earlier versions.
    const ruleCount = (
      database.prepare('SELECT COUNT(*) AS count FROM rules').get() as { count: number }
    ).count;
    const templateCount = (
      database.prepare('SELECT COUNT(*) AS count FROM reply_templates').get() as { count: number }
    ).count;
    const channelCount = (
      database.prepare('SELECT COUNT(*) AS count FROM channels').get() as { count: number }
    ).count;
    const assignmentCount = (
      database.prepare('SELECT COUNT(*) AS count FROM account_channels').get() as { count: number }
    ).count;

    // Never wipe a database that already contains any production data:
    // rules, reply templates, channels, or channel assignments. Only a truly
    // empty install (no channels and no automation config) is reset, and even
    // then the DELETEs below operate on empty tables and are no-ops.
    if (
      ruleCount > 0 ||
      templateCount > 0 ||
      channelCount > 0 ||
      assignmentCount > 0
    ) {
      return;
    }

    database.exec(`
      -- Reset channel system for redesign while preserving all other data
      -- This only runs on truly fresh databases (no rules or templates)
      -- Clears channel subscriptions to allow fresh bulk addition
      
      -- Delete in dependency order (reverse of creation)
      DELETE FROM automation_dispatches;
      DELETE FROM telegram_channel_sync_state;
      DELETE FROM account_channels;
      DELETE FROM channels;
      
      -- All other tables remain untouched:
      -- - accounts (session data)
      -- - owners (admin data)
      -- - rules (detection rules)
      -- - reply_templates (templates)
      -- - account_automation_settings (settings)
      -- - account_reply_templates (mappings)
      -- - logs (historical data)
    `);
  },
};
