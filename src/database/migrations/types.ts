import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly foreignKeysDisabled?: boolean;
  up(database: DatabaseSync): void;
}
