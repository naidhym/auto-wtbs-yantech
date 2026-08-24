import type { Migration } from './types.js';

export const accountNotificationTargetMigration: Migration = {
  version: 8,
  name: 'account_notification_target',
  up(database): void {
    database.exec(`
      ALTER TABLE account_automation_settings
        ADD COLUMN notification_target TEXT;
    `);
  },
};
