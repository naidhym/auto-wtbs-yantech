import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { UserAuthParams } from 'telegram/client/auth.js';
import { describe, expect, it } from 'vitest';

import { AccountManagerService } from '../src/accounts/account-manager.service.js';
import { AccountRepository } from '../src/accounts/account.repository.js';
import { AccountService } from '../src/accounts/account.service.js';
import { AccountSessionStore } from '../src/accounts/session-store.js';
import { DatabaseService } from '../src/database/database.service.js';
import { createLogger } from '../src/logging/logger.js';
import type {
  GramJsClientOptions,
  TelegramClientAdapter,
  TelegramClientFactory,
} from '../src/user-client/gramjs-client.service.js';
import { TelegramClientRegistry } from '../src/user-client/telegram-client.registry.js';

interface ClientBehavior {
  readonly connectError?: boolean;
  readonly invalidSession?: boolean;
  readonly requirePassword?: boolean;
  readonly loginError?: boolean;
}

class MockTelegramClient implements TelegramClientAdapter {
  public connected: boolean | undefined = false;

  public resolveChannel(identifier: string) {
    return Promise.resolve({ telegramChannelId: identifier, title: identifier });
  }

  public subscribeChannel() {
    return Promise.resolve(() => Promise.resolve());
  }

  public sendChannelComment() {
    return Promise.resolve({
      messageId: 1,
      resolveMessageLink: () => Promise.resolve('https://t.me/c/1/1'),
      reactToOwnComment: () => Promise.resolve({ status: 'sent' as const }),
    });
  }
  public sendOperationalNotification() {
    return Promise.resolve();
  }
  public connectCalls = 0;
  public disconnectCalls = 0;
  public startCalls = 0;
  private authorized: boolean;

  public constructor(
    private readonly accountKey: string,
    session: string,
    private readonly behavior: ClientBehavior,
  ) {
    this.authorized = session.length > 0 && !behavior.invalidSession;
  }

  public connect(): Promise<boolean> {
    this.connectCalls += 1;
    if (this.behavior.connectError) throw new Error('simulated connection error');
    this.connected = true;
    return Promise.resolve(true);
  }

  public disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    this.connected = false;
    return Promise.resolve();
  }

  public destroy(): Promise<void> {
    return this.disconnect();
  }

  public async start(authParams: UserAuthParams): Promise<void> {
    this.startCalls += 1;
    this.connected = true;
    const otp = await authParams.phoneCode(true);

    if (this.behavior.loginError || otp === '000') {
      const error = new Error('simulated login failure');
      await authParams.onError(error);
      throw error;
    }

    if (this.behavior.requirePassword) {
      if (authParams.password === undefined) throw new Error('password callback missing');
      await authParams.password('test hint');
    }

    this.authorized = true;
  }

  public checkAuthorization(): Promise<boolean> {
    return Promise.resolve(this.authorized);
  }

  public saveSession(): string {
    return `session:${this.accountKey}`;
  }

  public getTelegramUserId(): Promise<string> {
    return Promise.resolve(this.accountKey.endsWith('1') ? '900001' : '900002');
  }
}

describe('isolated multi-account lifecycle', () => {
  it('keeps login state, clients, and persistent sessions isolated per account', async () => {
    const harness = createHarness({
      'account-00000000-0000-4000-8000-000000000102': { requirePassword: true },
    });
    const first = harness.add('A', '+628111111101');
    const second = harness.add('B', '+628111111102');

    await expect(harness.manager.startLogin(first.accountKey)).resolves.toMatchObject({
      accountKey: first.accountKey,
      state: 'awaiting_otp',
    });
    await expect(harness.manager.startLogin(second.accountKey)).resolves.toMatchObject({
      accountKey: second.accountKey,
      state: 'awaiting_otp',
    });
    expect(harness.manager.getLoginStatus(first.accountKey)?.state).toBe('awaiting_otp');
    expect(harness.manager.getLoginStatus(second.accountKey)?.state).toBe('awaiting_otp');

    const firstResult = harness.manager.submitOtp(first.accountKey, '12345');
    await expect(harness.manager.submitOtp(second.accountKey, '54321')).resolves.toMatchObject({
      accountKey: second.accountKey,
      state: 'awaiting_password',
    });
    await expect(firstResult).resolves.toMatchObject({ state: 'authenticated' });
    await expect(
      harness.manager.submitPassword(second.accountKey, 'temporary-secret'),
    ).resolves.toMatchObject({ state: 'authenticated' });

    expect(harness.registry.getSummary()).toEqual({ registered: 2, connected: 2 });
    expect(harness.sessions.read(first.accountKey)).toBe(`session:${first.accountKey}`);
    expect(harness.sessions.read(second.accountKey)).toBe(`session:${second.accountKey}`);
    expect(harness.service.get(first.accountKey).enabled).toBe(true);
    expect(harness.service.get(second.accountKey).enabled).toBe(true);

    await harness.manager.shutdown();

    const restoredRegistry = new TelegramClientRegistry(harness.logger.logger);
    const restoredManager = harness.makeManager(restoredRegistry);
    await restoredManager.restoreEnabledAccounts();
    expect(restoredRegistry.getSummary()).toEqual({ registered: 2, connected: 2 });
    expect([...harness.clients.values()].every((client) => client.startCalls === 0)).toBe(
      true,
    );
    await restoredManager.remove(first.accountKey);
    expect(harness.sessions.has(first.accountKey)).toBe(false);
    expect(harness.sessions.has(second.accountKey)).toBe(true);
    expect(restoredRegistry.get(second.accountKey)?.getStatus().connected).toBe(true);
    await restoredManager.shutdown();
    harness.close();
  });

  it('contains connection and invalid-session failures to their own accounts', async () => {
    const failingKey = 'account-00000000-0000-4000-8000-000000000101';
    const invalidKey = 'account-00000000-0000-4000-8000-000000000103';
    const harness = createHarness({
      [failingKey]: { connectError: true },
      [invalidKey]: { invalidSession: true },
    });
    const failing = harness.add('Failing', '+628111111201');
    const healthy = harness.add('Healthy', '+628111111202');
    const invalid = harness.add('Invalid', '+628111111203');

    for (const account of [failing, healthy, invalid]) {
      harness.sessions.write(account.accountKey, `session:${account.accountKey}`);
      harness.service.setEnabled(account.accountKey, true);
    }

    await harness.manager.restoreEnabledAccounts();

    expect(harness.service.get(failing.accountKey).status).toBe('error');
    expect(harness.service.get(invalid.accountKey).status).toBe('error');
    expect(harness.sessions.has(invalid.accountKey)).toBe(false);
    expect(harness.sessions.has(failing.accountKey)).toBe(true);
    expect(harness.registry.get(healthy.accountKey)?.getStatus().connected).toBe(true);

    await expect(harness.manager.reconnect(failing.accountKey)).rejects.toThrow(
      /simulated connection error/i,
    );
    expect(harness.registry.get(healthy.accountKey)?.getStatus().connected).toBe(true);

    const failingClient = harness.clients.get(failing.accountKey);
    const healthyClient = harness.clients.get(healthy.accountKey);
    await harness.manager.reconnect(healthy.accountKey);
    expect(healthyClient?.connectCalls).toBeGreaterThan(1);
    expect(failingClient?.connectCalls).toBe(1);
    await harness.manager.shutdown();
    harness.close();
  });

  it('handles cancelled and failed logins without exposing credentials in logs', async () => {
    const failingKey = 'account-00000000-0000-4000-8000-000000000102';
    const harness = createHarness({ [failingKey]: { loginError: true } });
    const cancelled = harness.add('Cancelled', '+628111111301');
    const failing = harness.add('Failing', '+628111111302');

    await harness.manager.startLogin(cancelled.accountKey);
    await expect(harness.manager.cancelLogin(cancelled.accountKey)).resolves.toMatchObject({
      state: 'cancelled',
    });

    await harness.manager.startLogin(failing.accountKey);
    await expect(harness.manager.submitOtp(failing.accountKey, '99999')).resolves.toMatchObject({
      state: 'failed',
    });

    await harness.manager.shutdown();
    harness.logger.logger.flush();
    const log = fs.readFileSync(harness.logger.logFilePath, 'utf8');
    expect(log).not.toContain('99999');
    expect(log).not.toContain('+628111111302');
    expect(log).not.toContain('session:');
    harness.close();
  });

  it('times out one login without terminating another account client', async () => {
    const harness = createHarness({}, 25);
    const pending = harness.add('Pending', '+628111111401');
    const healthy = harness.add('Healthy', '+628111111402');
    harness.sessions.write(healthy.accountKey, `session:${healthy.accountKey}`);
    harness.service.setEnabled(healthy.accountKey, true);
    await harness.manager.restoreAccount(healthy.accountKey);

    await harness.manager.startLogin(pending.accountKey);
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(harness.manager.getLoginStatus(pending.accountKey)?.state).toBe('timed_out');
    expect(harness.registry.get(healthy.accountKey)?.getStatus().connected).toBe(true);
    await harness.manager.shutdown();
    harness.close();
  });
});

function createHarness(
  behaviors: Readonly<Record<string, ClientBehavior>>,
  loginTimeoutMs = 5_000,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-wtb-manager-'));
  const logger = createLogger({
    level: 'debug',
    logDirectory: path.join(root, 'logs'),
    environment: 'test',
    writeToStdout: false,
  });
  const database = new DatabaseService(path.join(root, 'accounts.sqlite'), logger.logger);
  const ownerId = '20000001';
  database.initialize();
  database.ensureOwner(ownerId);
  const keys = [
    'account-00000000-0000-4000-8000-000000000101',
    'account-00000000-0000-4000-8000-000000000102',
    'account-00000000-0000-4000-8000-000000000103',
  ];
  const service = new AccountService(
    new AccountRepository(database.getConnection()),
    ownerId,
    logger.logger,
    () => {
      const key = keys.shift();
      if (key === undefined) throw new Error('No test account key available');
      return key;
    },
  );
  const sessions = new AccountSessionStore(path.join(root, 'sessions'));
  const clients = new Map<string, MockTelegramClient>();
  const factory: TelegramClientFactory = (options: GramJsClientOptions) => {
    const client = new MockTelegramClient(
      options.accountKey,
      options.session ?? '',
      behaviors[options.accountKey] ?? {},
    );
    clients.set(options.accountKey, client);
    return client;
  };
  const registry = new TelegramClientRegistry(logger.logger);
  const makeManager = (clientRegistry: TelegramClientRegistry) =>
    new AccountManagerService(service, sessions, clientRegistry, logger.logger, {
      apiId: 12345,
      apiHash: 'not-a-real-api-hash',
      loginTimeoutMs,
      clientFactory: factory,
    });
  const manager = makeManager(registry);

  return {
    logger,
    database,
    service,
    sessions,
    clients,
    registry,
    manager,
    makeManager,
    add(label: string, phoneNumber: string) {
      return manager.addAccount({ label, phoneNumber });
    },
    close(): void {
      database.close();
      logger.close();
    },
  };
}
