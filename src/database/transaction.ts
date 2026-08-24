import type { DatabaseSync } from 'node:sqlite';

export function runInTransaction<T>(
  database: DatabaseSync,
  operation: () => T,
): T {
  database.exec('BEGIN IMMEDIATE');

  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'SQLite transaction failed and rollback was unsuccessful',
        { cause: rollbackError },
      );
    }

    throw error;
  }
}
