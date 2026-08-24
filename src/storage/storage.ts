import fs from 'node:fs';
import path from 'node:path';

import type { AppConfig } from '../config/config.js';

export interface StoragePaths {
  readonly databaseDirectory: string;
  readonly databasePath: string;
  readonly sessionDirectory: string;
  readonly logDirectory: string;
}

export function ensureStorageDirectories(config: AppConfig['storage']): StoragePaths {
  const databaseDirectory = path.dirname(config.databasePath);

  for (const directory of [
    databaseDirectory,
    config.sessionDirectory,
    config.logDirectory,
  ]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  return {
    databaseDirectory,
    databasePath: config.databasePath,
    sessionDirectory: config.sessionDirectory,
    logDirectory: config.logDirectory,
  };
}
