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

    // If there are any rules or templates, this is not a fresh database.
    // Skip the reset to preserve existing data.
    if (ruleCount > 0 || templateCount > 0) {
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
