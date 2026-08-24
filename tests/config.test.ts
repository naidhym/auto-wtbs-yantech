import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ConfigValidationError,
  loadConfig,
} from '../src/config/config.js';

describe('configuration', () => {
  it('loads and resolves validated values from .env', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-wtb-config-'));
    fs.writeFileSync(
      path.join(cwd, '.env'),
      [
        'NODE_ENV=test',
        'LOG_LEVEL=debug',
        'DATABASE_PATH=./private/database.sqlite',
        'SESSION_DIRECTORY=./private/sessions',
        'LOG_DIRECTORY=./private/logs',
        'ADMIN_BOT_ENABLED=true',
        'ADMIN_BOT_TOKEN=test-token',
        'OWNER_TELEGRAM_ID=123456789',
        'TELEGRAM_API_ID=12345',
        'TELEGRAM_API_HASH=test-api-hash',
      ].join('\n'),
    );

    const config = loadConfig({ cwd, environment: {} });

    expect(config.environment).toBe('test');
    expect(config.logLevel).toBe('debug');
    expect(config.storage.databasePath).toBe(
      path.join(cwd, 'private', 'database.sqlite'),
    );
    expect(config.adminBot).toEqual({
      enabled: true,
      token: 'test-token',
      ownerTelegramId: '123456789',
    });
    expect(config.telegram).toEqual({
      apiId: 12345,
      apiHash: 'test-api-hash',
    });
  });

  it('requires Admin Bot secrets only when the bot is enabled', () => {
    expect(() =>
      loadConfig({
        loadDotenv: false,
        environment: { ADMIN_BOT_ENABLED: 'true' },
      }),
    ).toThrow(ConfigValidationError);

    expect(() =>
      loadConfig({
        loadDotenv: false,
        environment: { ADMIN_BOT_ENABLED: 'false' },
      }),
    ).not.toThrow();
  });

  it('requires Telegram API credentials as a pair', () => {
    expect(() =>
      loadConfig({
        loadDotenv: false,
        environment: { TELEGRAM_API_ID: '12345' },
      }),
    ).toThrow('TELEGRAM_API_ID and TELEGRAM_API_HASH must be provided together');
  });

  it('rejects shared session and log directories', () => {
    expect(() =>
      loadConfig({
        cwd: '/tmp/auto-wtb-config-isolation',
        loadDotenv: false,
        environment: {
          SESSION_DIRECTORY: './runtime',
          LOG_DIRECTORY: './runtime',
        },
      }),
    ).toThrow('must resolve to different directories');
  });
});
