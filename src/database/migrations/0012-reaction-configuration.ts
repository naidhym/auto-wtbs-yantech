import type { Migration } from './types.js';

export const reactionConfigurationMigration: Migration = {
  version: 12,
  name: 'reaction_configuration',
  up(database): void {
    database.exec(`
      ALTER TABLE account_automation_settings
        ADD COLUMN reaction_type TEXT NOT NULL DEFAULT '❤️'
        CHECK (length(trim(reaction_type)) BETWEEN 1 AND 32);
    `);
  },
};
