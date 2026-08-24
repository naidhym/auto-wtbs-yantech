import type { Migration } from './types.js';

export const accountSessionMigration: Migration = {
  version: 2,
  name: 'account_session',
  up(database): void {
    database.exec(`
      ALTER TABLE accounts ADD COLUMN phone_number TEXT;

      CREATE UNIQUE INDEX idx_accounts_owner_phone_number
        ON accounts(owner_id, phone_number)
        WHERE phone_number IS NOT NULL;
    `);
  },
};
