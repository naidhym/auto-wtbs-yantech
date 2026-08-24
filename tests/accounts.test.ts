import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { AccountRepository } from '../src/accounts/account.repository.js';
import { AccountService } from '../src/accounts/account.service.js';
import { AccountSessionStore } from '../src/accounts/session-store.js';
import { DatabaseService } from '../src/database/database.service.js';
import { createLogger } from '../src/logging/logger.js';

describe('account and session persistence', () => {
  it('creates isolated accounts, rejects duplicates, updates state, and removes safely', () => {
    const runtime = createRuntime('auto-wtb-accounts-');
    const keys = [
      'account-00000000-0000-4000-8000-000000000001',
      'account-00000000-0000-4000-8000-000000000002',
    ];
    const service = new AccountService(
      new AccountRepository(runtime.database.getConnection()),
      runtime.ownerId,
      runtime.logger.logger,
      () => {
        const key = keys.shift();
        if (key === undefined) throw new Error('No test account key available');
        return key;
      },
    );

    const first = service.add({ label: 'Primary', phoneNumber: '+628111111111' });
    const second = service.add({ label: 'Backup', phoneNumber: '+628222222222' });

    expect(first.accountKey).not.toBe(second.accountKey);
    expect(first.nickname).toBe('Primary');
    expect(service.list()).toHaveLength(2);
    expect(() =>
      service.add({ label: 'Duplicate', phoneNumber: '+628111111111' }),
    ).toThrow(/already exists/i);
    expect(() =>
      service.add({ label: 'primary', phoneNumber: '+628333333333' }),
    ).toThrow(/nickname already exists/i);
    expect(() => service.rename(second.accountKey, 'PRIMARY')).toThrow(
      /nickname already exists/i,
    );
    expect(() => service.rename(first.accountKey, '   ')).toThrow(/1-64 characters/i);

    runtime.database.ensureOwner('10000002');
    const otherOwnerService = new AccountService(
      new AccountRepository(runtime.database.getConnection()),
      '10000002',
      runtime.logger.logger,
      () => 'account-00000000-0000-4000-8000-000000000003',
    );
    expect(
      otherOwnerService.add({ label: 'Backup', phoneNumber: '+628444444444' }),
    ).toMatchObject({ nickname: 'Backup' });
    expect(service.list()).toHaveLength(2);

    const sessions = new AccountSessionStore(
      path.join(runtime.runtimeDirectory, 'sessions'),
    );
    sessions.write(first.accountKey, 'stable-session');
    const sessionPath = sessions.getSessionPath(first.accountKey);
    const renamed = service.rename(first.accountKey, '  Main   Sales  ');
    expect(renamed).toMatchObject({
      accountKey: first.accountKey,
      nickname: 'Main Sales',
      label: 'Main Sales',
    });
    expect(sessions.getSessionPath(renamed.accountKey)).toBe(sessionPath);
    expect(sessions.read(renamed.accountKey)).toBe('stable-session');
    expect(service.setEnabled(first.accountKey, true)).toMatchObject({
      enabled: true,
      status: 'disconnected',
    });
    expect(service.updateStatus(first.accountKey, 'connected').status).toBe('connected');

    service.remove(second.accountKey);
    expect(service.list().map((account) => account.accountKey)).toEqual([
      first.accountKey,
    ]);
    expect(() => service.get(second.accountKey)).toThrow(/not found/i);
    runtime.close();
  });

  it('uses separate durable session paths and never stores session data in SQLite', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-wtb-sessions-'));
    const firstKey = 'account-00000000-0000-4000-8000-000000000011';
    const secondKey = 'account-00000000-0000-4000-8000-000000000012';
    const firstStore = new AccountSessionStore(root);

    firstStore.write(firstKey, 'persistent-session-a');
    firstStore.write(secondKey, 'persistent-session-b');

    expect(firstStore.getSessionPath(firstKey)).not.toBe(
      firstStore.getSessionPath(secondKey),
    );
    expect(firstStore.getSessionPath(firstKey)).toContain(
      path.join(firstKey, 'telegram.session'),
    );

    const restoredStore = new AccountSessionStore(root);
    expect(restoredStore.read(firstKey)).toBe('persistent-session-a');
    expect(restoredStore.read(secondKey)).toBe('persistent-session-b');

    restoredStore.remove(firstKey);
    expect(restoredStore.has(firstKey)).toBe(false);
    expect(restoredStore.read(secondKey)).toBe('persistent-session-b');
    expect(() => restoredStore.getSessionPath('../other-account')).toThrow(/unsafe/i);
  });
});

function createRuntime(prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const logger = createLogger({
    level: 'error',
    logDirectory: path.join(root, 'logs'),
    environment: 'test',
    writeToStdout: false,
  });
  const database = new DatabaseService(path.join(root, 'accounts.sqlite'), logger.logger);
  const ownerId = '10000001';
  database.initialize();
  database.ensureOwner(ownerId);

  return {
    runtimeDirectory: root,
    database,
    logger,
    ownerId,
    close(): void {
      database.close();
      logger.close();
    },
  };
}
