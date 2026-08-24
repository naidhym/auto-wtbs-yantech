import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { AccountRepository } from '../src/accounts/account.repository.js';
import { AccountService } from '../src/accounts/account.service.js';
import { ChannelListenerService } from '../src/channels/channel-listener.service.js';
import { ChannelRepository } from '../src/channels/channel.repository.js';
import { ChannelService } from '../src/channels/channel.service.js';
import type {
  ChannelAccessGateway,
  ChannelRecord,
  ResolvedTelegramChannel,
} from '../src/channels/channel.types.js';
import type { TelegramIncomingMessage } from '../src/rules/rule.types.js';
import { DatabaseService } from '../src/database/database.service.js';
import { createLogger, type LoggerHandle } from '../src/logging/logger.js';

const OWNER = '123456789';
const KEY_A = 'account-00000000-0000-4000-8000-000000000701';
const KEY_B = 'account-00000000-0000-4000-8000-000000000702';

class FakeChannelGateway implements ChannelAccessGateway {
  public readonly resolutions: Array<{ accountKey: string; identifier: string }> = [];
  public readonly subscriptions = new Map<string, {
    error: (error: unknown) => Promise<void> | void;
    stopped: boolean;
  }>();
  public failAccount?: string;

  public resolve(accountKey: string, identifier: string): Promise<ResolvedTelegramChannel> {
    this.resolutions.push({ accountKey, identifier });
    if (identifier.includes('missing')) return Promise.reject(new Error('CHANNEL_PRIVATE'));
    const slug = identifier.replace(/^@/, '').replace(/\W/g, '').toLowerCase();
    return Promise.resolve({
      telegramChannelId: slug === 'sharedchannel' ? '100700' : `100${slug.length}`,
      username: slug,
      title: slug === 'sharedchannel' ? 'Shared Channel' : slug,
    });
  }

  public subscribe(
    accountKey: string,
    channel: ChannelRecord,
    _onMessage: (event: TelegramIncomingMessage) => Promise<void>,
    onError: (error: unknown) => Promise<void> | void,
  ): Promise<() => Promise<void>> {
    void _onMessage;
    if (this.failAccount === accountKey) return Promise.reject(new Error('FLOOD_WAIT_10'));
    const key = `${accountKey}:${channel.id}`;
    this.subscriptions.set(key, { error: onError, stopped: false });
    return Promise.resolve(() => {
      const subscription = this.subscriptions.get(key);
      if (subscription !== undefined) subscription.stopped = true;
      return Promise.resolve();
    });
  }
}

describe('M3 independent channel management', () => {
  it('supports CRUD, global deduplication, many-to-many assignment, validation, and enable state', async () => {
    const harness = createHarness();
    const first = await harness.service.addChannel('@sharedchannel', KEY_A);
    expect(first.channel.title).toBe('Shared Channel');
    expect(first.assignments.map((item) => item.accountKey)).toEqual([KEY_A]);
    expect(harness.gateway.resolutions[0]).toEqual({ accountKey: KEY_A, identifier: '@sharedchannel' });

    await expect(harness.service.addChannel('@sharedchannel', KEY_A))
      .rejects.toThrow(/already monitors/i);
    expect(harness.service.listChannels()).toHaveLength(1);

    const shared = await harness.service.assignAccount(first.channel.id, KEY_B);
    expect(shared.assignments.map((item) => item.accountKey).sort()).toEqual([KEY_A, KEY_B]);
    await expect(harness.service.assignAccount(first.channel.id, KEY_B))
      .rejects.toThrow(/already assigned/i);

    const bAssignment = shared.assignments.find((item) => item.accountKey === KEY_B);
    expect(bAssignment).toBeDefined();
    await harness.service.setAssignmentEnabled(bAssignment!.id, false);
    expect(harness.service.getChannel(first.channel.id).assignments
      .find((item) => item.id === bAssignment!.id)?.enabled).toBe(false);

    await harness.service.setChannelEnabled(first.channel.id, false);
    expect(harness.service.getChannel(first.channel.id).channel.enabled).toBe(false);
    await harness.service.setChannelEnabled(first.channel.id, true);
    expect(harness.service.getChannel(first.channel.id).channel.enabled).toBe(true);

    await harness.service.unassign(bAssignment!.id);
    expect(harness.service.getChannel(first.channel.id).assignments).toHaveLength(1);
    await harness.service.removeChannel(first.channel.id);
    expect(harness.service.listChannels()).toHaveLength(0);
    harness.close();
  });

  it('rejects inaccessible channels without creating data', async () => {
    const harness = createHarness();
    await expect(harness.service.addChannel('@missingchannel', KEY_A))
      .rejects.toThrow('CHANNEL_PRIVATE');
    expect(harness.service.listChannels()).toHaveLength(0);
    harness.close();
  });

  it('isolates listener and account failures', async () => {
    const harness = createHarness();
    const detail = await harness.service.addChannel('@sharedchannel', KEY_A);
    await harness.service.assignAccount(detail.channel.id, KEY_B);
    const assignments = harness.service.getChannel(detail.channel.id).assignments;
    const listenerA = assignments.find((item) => item.accountKey === KEY_A)!;
    const listenerB = assignments.find((item) => item.accountKey === KEY_B)!;
    const keyA = `${KEY_A}:${detail.channel.id}`;
    const keyB = `${KEY_B}:${detail.channel.id}`;

    await harness.gateway.subscriptions.get(keyA)!.error(new Error('FLOOD_WAIT_10'));
    expect(harness.listener.isActive(listenerA.id)).toBe(false);
    expect(harness.listener.isActive(listenerB.id)).toBe(true);
    expect(harness.gateway.subscriptions.get(keyA)!.stopped).toBe(true);
    expect(harness.service.getChannel(detail.channel.id).assignments
      .find((item) => item.id === listenerA.id)?.status).toBe('error');

    await harness.service.stopAccountListeners(KEY_A);
    expect(harness.gateway.subscriptions.get(keyB)!.stopped).toBe(false);
    await harness.service.restartAccountListeners(KEY_A);
    expect(harness.listener.isActive(listenerB.id)).toBe(true);
    harness.close();
  });

  it('starts owner-scoped 1xN and Nx1 assignments with isolated failure summaries', async () => {
    const harness = createHarness();
    const shared = await harness.service.addChannel('@sharedchannel', KEY_A);
    await harness.service.assignAccount(shared.channel.id, KEY_B);
    await harness.service.addChannel('@secondchannel', KEY_A);
    harness.connection.prepare('UPDATE accounts SET is_enabled = 1').run();
    harness.connection.exec(`
      INSERT INTO owners (telegram_user_id, is_active) VALUES ('999999999', 1);
      INSERT INTO accounts (
        owner_id, label, phone_number, session_key, status, is_enabled
      ) VALUES (
        2, 'Other Owner', '+628333333333',
        'account-00000000-0000-4000-8000-000000000799', 'connected', 1
      );
      INSERT INTO account_channels (account_id, channel_id, is_enabled, status)
      VALUES (3, 1, 1, 'active');
    `);
    await harness.listener.stopAll();

    await expect(harness.listener.startAll(OWNER)).resolves.toEqual({
      eligible: 3,
      active: 3,
      failed: 0,
    });

    await harness.listener.stopAll();
    harness.gateway.failAccount = KEY_A;
    await expect(harness.listener.startAll(OWNER)).resolves.toEqual({
      eligible: 3,
      active: 1,
      failed: 2,
    });
    const bAssignment = harness.service.getChannel(shared.channel.id).assignments
      .find((assignment) => assignment.accountKey === KEY_B);
    expect(bAssignment).toBeDefined();
    expect(harness.listener.isActive(bAssignment!.id)).toBe(true);
    harness.close();
  });
});

function createHarness(): {
  database: DatabaseService;
  connection: DatabaseSync;
  service: ChannelService;
  listener: ChannelListenerService;
  gateway: FakeChannelGateway;
  logger: LoggerHandle;
  close(): void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-wtb-channels-'));
  const logger = createLogger({
    level: 'error',
    logDirectory: path.join(root, 'logs'),
    environment: 'test',
    writeToStdout: false,
  });
  const database = new DatabaseService(path.join(root, 'db.sqlite'), logger.logger);
  database.initialize();
  database.ensureOwner(OWNER);
  const connection = database.getConnection();
  const accountRepository = new AccountRepository(connection);
  const keys = [KEY_A, KEY_B];
  const accounts = new AccountService(
    accountRepository,
    OWNER,
    logger.logger,
    () => keys.shift() ?? KEY_B,
  );
  accounts.add({ label: 'Account A', phoneNumber: '+628111111111' });
  accounts.add({ label: 'Account B', phoneNumber: '+628222222222' });
  const repository = new ChannelRepository(connection);
  const gateway = new FakeChannelGateway();
  const listener = new ChannelListenerService(repository, gateway, logger.logger);
  const service = new ChannelService(
    repository,
    accounts,
    OWNER,
    gateway,
    listener,
    logger.logger,
  );
  return {
    database,
    connection,
    service,
    listener,
    gateway,
    logger,
    close(): void {
      database.close();
      logger.close();
    },
  };
}
