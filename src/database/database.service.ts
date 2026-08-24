import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { errorReason, type AppLogger } from '../logging/logger.js';
import { migrations } from './migrations/index.js';
import { runInTransaction } from './transaction.js';

const MIGRATION_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )
`;

export const FOUNDATION_TABLES = [
  'account_automation_settings',
  'account_channels',
  'accounts',
  'automation_dispatches',
  'channels',
  'logs',
  'owners',
  'reply_templates',
  'rules',
  'settings',
] as const;

export function configureSqliteConnection(connection: DatabaseSync): void {
  connection.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
  `);
}

export class DatabaseService {
  private connection: DatabaseSync | undefined;

  public constructor(
    private readonly databasePath: string,
    private readonly logger: AppLogger,
  ) {}

  public initialize(): void {
    if (this.connection !== undefined) {
      return;
    }

    const connection = new DatabaseSync(this.databasePath);

    try {
      configureSqliteConnection(connection);
      connection.exec(MIGRATION_TABLE_SQL);
      this.runMigrations(connection);
      this.connection = connection;

      this.logger.info(
        {
          action: 'database_initialize',
          status: 'ready',
          database: path.basename(this.databasePath),
          migrationVersion: this.getMigrationVersion(),
        },
        'SQLite foundation initialized',
      );
    } catch (error) {
      connection.close();
      this.logger.error(
        {
          action: 'database_initialize',
          status: 'failed',
          errorReason: errorReason(error),
        },
        'SQLite foundation initialization failed',
      );
      throw error;
    }
  }

  public ensureOwner(telegramUserId: string): void {
    this.getConnection()
      .prepare(
        `
          INSERT INTO owners (telegram_user_id, is_active)
          VALUES (?, 1)
          ON CONFLICT(telegram_user_id) DO UPDATE SET
            is_active = 1,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        `,
      )
      .run(telegramUserId);
  }

  public getMigrationVersion(): number {
    if (this.connection === undefined) {
      return 0;
    }

    const row = this.connection
      .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
      .get() as { version: number };

    return row.version;
  }

  public getTableNames(): string[] {
    return this.getConnection()
      .prepare(
        `
          SELECT name
          FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name
        `,
      )
      .all()
      .map((row) => (row as { name: string }).name);
  }

  public isOpen(): boolean {
    return this.connection !== undefined;
  }

  public close(): void {
    if (this.connection === undefined) {
      return;
    }

    this.connection.close();
    this.connection = undefined;
  }

  public getConnection(): DatabaseSync {
    if (this.connection === undefined) {
      throw new Error('Database is not initialized');
    }

    return this.connection;
  }

  private runMigrations(connection: DatabaseSync): void {
    const appliedVersions = new Set(
      connection
        .prepare('SELECT version FROM schema_migrations')
        .all()
        .map((row) => (row as { version: number }).version),
    );

    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }

      if (migration.foreignKeysDisabled === true) {
        connection.exec('PRAGMA foreign_keys = OFF;');
      }

      try {
        runInTransaction(connection, () => {
          migration.up(connection);
          const violations = connection.prepare('PRAGMA foreign_key_check').all();

          if (violations.length > 0) {
            throw new Error(`Migration ${migration.version} introduced foreign key violations`);
          }

          connection
            .prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
            .run(migration.version, migration.name);
        });
      } finally {
        if (migration.foreignKeysDisabled === true) {
          connection.exec('PRAGMA foreign_keys = ON;');
        }
      }
      this.logger.info(
        {
          action: 'database_migration',
          status: 'applied',
          migrationVersion: migration.version,
          migrationName: migration.name,
        },
        'Database migration applied',
      );
    }
  }
}
