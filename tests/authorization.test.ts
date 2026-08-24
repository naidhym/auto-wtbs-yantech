import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AdminBotService,
  type AdminBotLifecycleAdapter,
} from '../src/admin-bot/admin-bot.service.js';
import { isOwner } from '../src/admin-bot/authorization.js';
import { createLogger } from '../src/logging/logger.js';

describe('Admin Bot owner authorization', () => {
  it('allows only the exact configured Owner ID', () => {
    expect(isOwner(123456789, '123456789')).toBe(true);
    expect(isOwner('123456789', '123456789')).toBe(true);
    expect(isOwner(987654321, '123456789')).toBe(false);
    expect(isOwner(undefined, '123456789')).toBe(false);
  });

  it('supports start and stop without exposing non-foundation commands', async () => {
    const logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-wtb-admin-'));
    const loggerHandle = createLogger({
      level: 'error',
      logDirectory,
      environment: 'test',
      writeToStdout: false,
    });
    let launchCalls = 0;
    let stopCalls = 0;
    const lifecycle: AdminBotLifecycleAdapter = {
      launch(): Promise<void> {
        launchCalls += 1;
        return Promise.resolve();
      },
      stop(): void {
        stopCalls += 1;
      },
    };
    const service = new AdminBotService(
      {
        token: '123456:test-token',
        ownerTelegramId: '123456789',
        logger: loggerHandle.logger,
        statusProvider: () => ({
          service: 'auto-wtb-bot',
          state: 'running',
          uptimeSeconds: 1,
          migrationVersion: 1,
          registeredTelegramClients: 0,
          connectedTelegramClients: 0,
        }),
      },
      lifecycle,
    );

    await service.start();
    expect(service.isRunning()).toBe(true);
    expect(launchCalls).toBe(1);

    await service.stop('test complete');
    expect(service.isRunning()).toBe(false);
    expect(stopCalls).toBe(1);
    loggerHandle.close();
  });

  it('reports ready without awaiting polling lifetime and can stop while launch is starting', async () => {
    const logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-wtb-admin-lifecycle-'));
    const loggerHandle = createLogger({
      level: 'error',
      logDirectory,
      environment: 'test',
      writeToStdout: false,
    });
    let resolveLaunch!: () => void;
    let readyCallback: (() => void) | undefined;
    const lifecycle: AdminBotLifecycleAdapter = {
      launch(_bot, onReady): Promise<void> {
        readyCallback = onReady;
        return new Promise((resolve) => {
          resolveLaunch = resolve;
        });
      },
      stop(): void {
        resolveLaunch();
      },
    };
    const service = new AdminBotService(
      {
        token: '123456:test-token',
        ownerTelegramId: '123456789',
        logger: loggerHandle.logger,
        statusProvider: () => ({
          service: 'auto-wtb-bot',
          state: 'starting',
          uptimeSeconds: 0,
          migrationVersion: 6,
          registeredTelegramClients: 0,
          connectedTelegramClients: 0,
        }),
      },
      lifecycle,
    );

    const starting = service.start();
    await Promise.resolve();
    expect(readyCallback).toBeDefined();
    readyCallback?.();
    await expect(starting).resolves.toBeUndefined();
    expect(service.isRunning()).toBe(true);
    await expect(service.stop('test stop')).resolves.toBeUndefined();
    expect(service.isRunning()).toBe(false);

    let resolveSecondLaunch!: () => void;
    const stopDuringStart = new AdminBotService(
      {
        token: '123456:test-token',
        ownerTelegramId: '123456789',
        logger: loggerHandle.logger,
        statusProvider: () => ({
          service: 'auto-wtb-bot',
          state: 'starting',
          uptimeSeconds: 0,
          migrationVersion: 6,
          registeredTelegramClients: 0,
          connectedTelegramClients: 0,
        }),
      },
      {
        launch(): Promise<void> {
          return new Promise((resolve) => {
            resolveSecondLaunch = resolve;
          });
        },
        stop(): void {
          resolveSecondLaunch();
        },
      },
    );
    const secondStarting = stopDuringStart.start();
    await Promise.resolve();
    await expect(stopDuringStart.stop('early stop')).resolves.toBeUndefined();
    await expect(secondStarting).resolves.toBeUndefined();
    expect(stopDuringStart.isRunning()).toBe(false);
    loggerHandle.close();
  });
});
