import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Telegraf } from 'telegraf';
import { describe, expect, it, vi } from 'vitest';

import { AutoWtbApplication } from '../src/app.js';
import { loadConfig } from '../src/config/config.js';

describe('application lifecycle', () => {
  it('starts the final runtime and shuts down cleanly', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-wtb-app-'));
    const config = loadConfig({
      cwd,
      loadDotenv: false,
      environment: {
        NODE_ENV: 'test',
        LOG_LEVEL: 'error',
        ADMIN_BOT_ENABLED: 'false',
      },
    });
    const application = new AutoWtbApplication(config);

    await application.start();

    expect(application.getStatus()).toMatchObject({
      milestone: 'M6',
      state: 'running',
      migrationVersion: 12,
      adminBotEnabled: false,
      adminBotRunning: false,
      registeredTelegramClients: 0,
      connectedTelegramClients: 0,
    });
    expect(fs.existsSync(config.storage.databasePath)).toBe(true);
    expect(fs.statSync(config.storage.sessionDirectory).isDirectory()).toBe(true);
    expect(fs.statSync(config.storage.logDirectory).isDirectory()).toBe(true);

    await application.shutdown('test complete');

    expect(application.getStatus().state).toBe('stopped');
    await expect(application.waitForShutdown()).resolves.toBeUndefined();
  });

  it('reaches running with Admin Bot polling still active and stops it before logger close', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-wtb-app-admin-'));
    let resolvePolling!: () => void;
    const launch = vi.spyOn(Telegraf.prototype, 'launch').mockImplementation(
      (...args: unknown[]): Promise<void> => {
        const onLaunch = args[1];
        if (typeof onLaunch === 'function') (onLaunch as () => void)();
        return new Promise((resolve) => {
          resolvePolling = resolve;
        });
      },
    );
    const stop = vi.spyOn(Telegraf.prototype, 'stop').mockImplementation(() => {
      resolvePolling();
    });
    const config = loadConfig({
      cwd,
      loadDotenv: false,
      environment: {
        NODE_ENV: 'test',
        LOG_LEVEL: 'error',
        ADMIN_BOT_ENABLED: 'true',
        ADMIN_BOT_TOKEN: '123456:test-token',
        OWNER_TELEGRAM_ID: '123456789',
      },
    });
    const application = new AutoWtbApplication(config);

    try {
      await expect(application.start()).resolves.toBeUndefined();
      expect(application.getStatus()).toMatchObject({
        state: 'running',
        adminBotEnabled: true,
        adminBotRunning: true,
      });
      await expect(application.shutdown('admin lifecycle test')).resolves.toBeUndefined();
      expect(application.getStatus().state).toBe('stopped');
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      launch.mockRestore();
      stop.mockRestore();
    }
  });
});
