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
  ChannelAssignmentRecord,
  ChannelMessageProcessor,
  ChannelRecord,
  ResolvedTelegramChannel,
} from '../src/channels/channel.types.js';
import type { TelegramIncomingMessage } from '../src/rules/rule.types.js';
import { TelegramChannelSyncStateRepository } from '../src/user-client/telegram-channel-sync-state.repository.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  type ChannelPostReceived,
  type EventSubscriber,
  type TelegramEvent,
  TelegramEventBus,
} from '../src/shared/telegram-events.js';
import { toCanonicalChannelId } from '../src/shared/telegram-channel-id.js';
import { createLogger, type LoggerHandle } from '../src/logging/logger.js';

const OWNER = '123456789';
const KEY_A = 'account-00000000-0000-4000-8000-000000000701';
const KEY_B = 'account-00000000-0000-4000-8000-000000000702';

const PROD8 = [
  '1611324665',
  '3980589729',
  '1303979309',
  '1441823150',
  '1202510480',
  '1274048263',
  '4436049182',
  '1525948158',
];
const PROD8_CANON = PROD8.map((id) => toCanonicalChannelId(id));

/**
 * Deterministic integration gateway.
 *
 * This is NOT real Telegram. It simulates the native client sufficiently to
 * prove the full monitoring pipeline (resolve -> create -> assignment ->
 * registry -> sync -> healthy -> listener -> live event) using mocked,
 * deterministic Telegram updates. Real Telegram verification is out of scope
 * here and must be performed separately against live accounts.
 */
class MonitoringGateway implements ChannelAccessGateway {
  public readonly resolutions: Array<{ accountKey: string; identifier: string }> = [];
  public readonly registrations = new Map<string, Set<number>>();
  private readonly handlers = new Map<string, (message: TelegramIncomingMessage) => Promise<void>>();
  public readonly failIdentifiers = new Set<string>();

  public constructor(
    private readonly syncStates: TelegramChannelSyncStateRepository,
  ) {}

  public resolve(accountKey: string, identifier: string): Promise<ResolvedTelegramChannel> {
    this.resolutions.push({ accountKey, identifier });
    if (this.failIdentifiers.has(identifier)) {
      return Promise.reject(new Error('CHANNEL_PRIVATE'));
    }
    const trimmed = identifier.trim();
    const resolved: ResolvedTelegramChannel = /^-?\d+$/.test(trimmed)
      ? { telegramChannelId: toCanonicalChannelId(trimmed), title: `Channel ${toCanonicalChannelId(trimmed)}`, entityType: 'channel' }
      : (() => {
          const slug = trimmed.replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '').replace(/\W/g, '').toLowerCase();
          return { telegramChannelId: slug, title: slug, username: slug, entityType: 'channel' };
        })();
    return Promise.resolve(resolved);
  }

  public getNativeClientInstanceId(accountKey: string): string {
    return `engine:${accountKey}`;
  }

  public subscribe(
    accountKey: string,
    assignment: ChannelAssignmentRecord,
    channel: ChannelRecord,
    onMessage: (message: TelegramIncomingMessage) => Promise<void>,
  ): Promise<() => Promise<void>> {
    const key = `${accountKey}:${channel.id}`;
    const set = this.registrations.get(accountKey) ?? new Set<number>();
    set.add(channel.id);
    this.registrations.set(accountKey, set);
    this.handlers.set(key, onMessage);
    this.syncStates.ensure(assignment.accountId, channel.id);
    this.syncStates.markHealthy(assignment.accountId, channel.id, 1);
    return Promise.resolve(() => {
      this.handlers.delete(key);
      set.delete(channel.id);
      return Promise.resolve();
    });
  }

  public deliverPost(accountKey: string, channelId: number, message: TelegramIncomingMessage): Promise<void> {
    const handler = this.handlers.get(`${accountKey}:${channelId}`);
    if (handler === undefined) return Promise.reject(new Error('no active subscription'));
    return handler(message);
  }
}

/** Records every emitted ChannelPostReceived for deterministic verification. */
class EventCollector implements EventSubscriber {
  public readonly events: ChannelPostReceived[] = [];
  public onEvent(event: TelegramEvent): Promise<void> {
    if (event.type === 'channel_post_received') this.events.push(event);
    return Promise.resolve();
  }
}

/** Converts a live listener delivery into a normalized ChannelPostReceived. */
class RecordingProcessor implements ChannelMessageProcessor {
  public constructor(private readonly eventBus: TelegramEventBus) {}
  public async process(input: Parameters<ChannelMessageProcessor['process']>[0]): Promise<void> {
    const message = input.message;
    const event: ChannelPostReceived = {
      type: 'channel_post_received',
      accountId: input.assignment.accountId,
      accountKey: input.assignment.accountKey,
      channelId: input.channel.id,
      telegramChannelId: input.channel.telegramChannelId,
      messageId: message.sourceMessageId ?? 0,
      text: message.text,
      senderDisplayName: message.senderDisplayName ?? '',
      timestamp: new Date(),
      isHistorical: false,
      correlationId: message.correlationId ?? 'test',
    };
    await this.eventBus.emit(event);
  }
}

interface Harness {
  database: DatabaseService;
  connection: DatabaseSync;
  accounts: AccountService;
  repository: ChannelRepository;
  syncStates: TelegramChannelSyncStateRepository;
  gateway: MonitoringGateway;
  listener: ChannelListenerService;
  service: ChannelService;
  logger: LoggerHandle;
  eventBus: TelegramEventBus;
  close(): void;
}

function openHarness(dbPath: string, eventBus: TelegramEventBus): Harness {
  const logDir = path.join(path.dirname(dbPath), 'logs');
  const logger = createLogger({
    level: 'error',
    logDirectory: logDir,
    environment: 'test',
    writeToStdout: false,
  });
  const database = new DatabaseService(dbPath, logger.logger);
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
  if (accounts.list().length === 0) {
    accounts.add({ label: 'Shark', phoneNumber: '+628111111111' });
    accounts.add({ label: 'Draco', phoneNumber: '+628222222222' });
  }
  connection.prepare('UPDATE accounts SET is_enabled = 1, status = ?').run('connected');
  const repository = new ChannelRepository(connection);
  const syncStates = new TelegramChannelSyncStateRepository(connection);
  const gateway = new MonitoringGateway(syncStates);
  const listener = new ChannelListenerService(repository, gateway, logger.logger, new RecordingProcessor(eventBus));
  const service = new ChannelService(repository, accounts, OWNER, gateway, listener, logger.logger);
  return {
    database,
    connection,
    accounts,
    repository,
    syncStates,
    gateway,
    listener,
    service,
    logger,
    eventBus,
    close(): void {
      database.close();
      logger.close();
    },
  };
}

function makeDbPath(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(dir, 'data.sqlite');
}

function channelIdFor(harness: Harness, telegramChannelId: string): number {
  const channel = harness.repository.getByTelegramId(telegramChannelId);
  if (channel === undefined) throw new Error(`channel not created: ${telegramChannelId}`);
  return channel.id;
}

function deliver(
  harness: Harness,
  accountKey: string,
  channelId: number,
  telegramChannelId: string,
  messageId: number,
): Promise<void> {
  const message: TelegramIncomingMessage = {
    chatKind: 'supergroup',
    sourceMessageId: messageId,
    text: `post ${messageId}`,
    senderDisplayName: 'Test Sender',
    telegramChannelId,
  };
  return harness.gateway.deliverPost(accountKey, channelId, message);
}

/**
 * Verifies the full monitoring matrix cell for one channel x one account:
 * resolve, create, assignment, registry, sync, healthy, listener active.
 */
function verifyMonitoringCell(
  harness: Harness,
  telegramChannelId: string,
  accountKey: string,
  expectResolved = true,
): void {
  const channel = harness.repository.getByTelegramId(telegramChannelId);
  expect(channel, `channel created for ${telegramChannelId}`).toBeDefined();
  const account = harness.accounts.get(accountKey);
  const assignment = harness.repository.getAssignment(account.id, channel!.id);
  expect(assignment, `assignment exists for ${telegramChannelId} / ${accountKey}`).toBeDefined();
  expect(assignment!.enabled).toBe(true);
  expect(assignment!.status).toBe('healthy');

  const instanceId = harness.gateway.getNativeClientInstanceId(accountKey);
  expect(instanceId).toBe(`engine:${accountKey}`);
  expect(harness.gateway.registrations.get(accountKey)?.has(channel!.id)).toBe(true);

  const sync = harness.syncStates.get(account.id, channel!.id);
  expect(sync, `sync state for ${telegramChannelId} / ${accountKey}`).toBeDefined();
  expect(sync!.syncStatus).toBe('healthy');

  expect(harness.listener.isActive(assignment!.id)).toBe(true);
  const snap = harness.listener.getDiagnosticSnapshot().find((item) => item.assignmentId === assignment!.id);
  expect(snap, `listener registered for ${telegramChannelId} / ${accountKey}`).toBeDefined();
  expect(snap!.nativeClientInstanceId).toBe(instanceId);

  if (expectResolved) {
    expect(
      harness.gateway.resolutions.some((item) => item.accountKey === accountKey && item.identifier === telegramChannelId),
      `resolved through ${accountKey}`,
    ).toBe(true);
  }
}

function verifyLiveEvents(
  collector: EventCollector,
  harness: Harness,
  channels: string[],
  accounts: string[],
  messageIdFor: (index: number) => number,
): void {
  for (let i = 0; i < channels.length; i++) {
    const channelId = channelIdFor(harness, channels[i]!);
    for (const accountKey of accounts) {
      const matching = collector.events.filter(
        (event) => event.accountKey === accountKey && event.channelId === channelId && event.messageId === messageIdFor(i),
      );
      expect(matching, `exactly one live event for ${channels[i]} / ${accountKey}`).toHaveLength(1);
    }
  }
}

describe('FULL MONITORING MATRIX (deterministic integration verification)', () => {
  it('8 channels x 2 accounts: full registration, sync, health, and live-event matrix', async () => {
    const dbPath = makeDbPath('mm-full-');
    const eventBus = new TelegramEventBus();
    const collector = new EventCollector();
    eventBus.subscribe(collector);
    const harness = openHarness(dbPath, eventBus);

    const result = await harness.service.addBulkChannels(PROD8_CANON, [KEY_A, KEY_B]);
    expect(result.failed).toHaveLength(0);
    expect(result.created).toHaveLength(8);

    const summary = await harness.listener.startAll(OWNER);
    expect(summary.eligible).toBe(16);
    expect(summary.active).toBe(16);
    expect(summary.failed).toBe(0);

    for (const id of PROD8_CANON) {
      for (const accountKey of [KEY_A, KEY_B]) {
        verifyMonitoringCell(harness, id, accountKey);
      }
    }

    collector.events.length = 0;
    for (let i = 0; i < PROD8_CANON.length; i++) {
      for (const accountKey of [KEY_A, KEY_B]) {
        await deliver(harness, accountKey, channelIdFor(harness, PROD8_CANON[i]!), PROD8_CANON[i]!, i + 1);
      }
    }
    expect(collector.events).toHaveLength(16);
    verifyLiveEvents(collector, harness, PROD8_CANON, [KEY_A, KEY_B], (i) => i + 1);

    harness.close();
  });

  it('same channel assigned to Shark + Draco: one post -> exactly one event per account (no suppression, no duplication)', async () => {
    const dbPath = makeDbPath('mm-iso-');
    const eventBus = new TelegramEventBus();
    const collector = new EventCollector();
    eventBus.subscribe(collector);
    const harness = openHarness(dbPath, eventBus);

    await harness.service.addBulkChannels([PROD8_CANON[0]!], [KEY_A, KEY_B]);
    await harness.listener.startAll(OWNER);
    verifyMonitoringCell(harness, PROD8_CANON[0]!, KEY_A);
    verifyMonitoringCell(harness, PROD8_CANON[0]!, KEY_B);

    collector.events.length = 0;
    const channelId = channelIdFor(harness, PROD8_CANON[0]!);
    await deliver(harness, KEY_A, channelId, PROD8_CANON[0]!, 999);
    await deliver(harness, KEY_B, channelId, PROD8_CANON[0]!, 999);

    expect(collector.events).toHaveLength(2);
    expect(collector.events.filter((e) => e.accountKey === KEY_A && e.messageId === 999)).toHaveLength(1);
    expect(collector.events.filter((e) => e.accountKey === KEY_B && e.messageId === 999)).toHaveLength(1);

    harness.close();
  });

  it('one channel failure is isolated; other channels keep monitoring (4436049182 classified as genuine per-account resolution failure)', async () => {
    const dbPath = makeDbPath('mm-fail-');
    const eventBus = new TelegramEventBus();
    const collector = new EventCollector();
    eventBus.subscribe(collector);
    const harness = openHarness(dbPath, eventBus);

    harness.gateway.failIdentifiers.add('4436049182');
    const result = await harness.service.addBulkChannels(PROD8_CANON, [KEY_A, KEY_B]);
    expect(result.failed).toHaveLength(2);
    expect(result.failed.every((f) => f.identifier === '4436049182')).toBe(true);
    expect(result.created).toHaveLength(7);

    await harness.listener.startAll(OWNER);

    const good = PROD8_CANON.filter((id) => id !== '4436049182');
    for (const id of good) {
      for (const accountKey of [KEY_A, KEY_B]) {
        verifyMonitoringCell(harness, id, accountKey);
      }
    }

    const failedChannel = harness.repository.getByTelegramId('4436049182');
    expect(failedChannel).toBeUndefined();
    for (const accountKey of [KEY_A, KEY_B]) {
      expect(harness.gateway.registrations.get(accountKey)?.has(channelIdForOrNegative(harness, '4436049182'))).toBe(false);
    }

    collector.events.length = 0;
    for (const id of good) {
      const channelId = channelIdFor(harness, id);
      await deliver(harness, KEY_A, channelId, id, 5);
      await deliver(harness, KEY_B, channelId, id, 5);
    }
    expect(collector.events).toHaveLength(14);

    const failedChannelId = failedChannel?.id ?? -1;
    await expect(harness.gateway.deliverPost(KEY_A, failedChannelId, {
      chatKind: 'supergroup',
      sourceMessageId: 5,
      text: 'should not arrive',
      telegramChannelId: '4436049182',
    })).rejects.toThrow('no active subscription');
    expect(collector.events.some((e) => e.telegramChannelId === '4436049182')).toBe(false);

    harness.close();
  });

  it('runtime channel addition monitors without restart', async () => {
    const dbPath = makeDbPath('mm-rt-');
    const eventBus = new TelegramEventBus();
    const collector = new EventCollector();
    eventBus.subscribe(collector);
    const harness = openHarness(dbPath, eventBus);

    await harness.service.addBulkChannels(PROD8_CANON.slice(0, 3), [KEY_A, KEY_B]);
    await harness.listener.startAll(OWNER);
    expect(harness.listener.getDiagnosticSnapshot()).toHaveLength(6);

    const runtimeId = toCanonicalChannelId('555111222');
    const runtimeResult = await harness.service.addBulkChannels([runtimeId], [KEY_A, KEY_B]);
    expect(runtimeResult.created).toHaveLength(1);
    verifyMonitoringCell(harness, runtimeId, KEY_A);
    verifyMonitoringCell(harness, runtimeId, KEY_B);

    collector.events.length = 0;
    const channelId = channelIdFor(harness, runtimeId);
    await deliver(harness, KEY_A, channelId, runtimeId, 7);
    await deliver(harness, KEY_B, channelId, runtimeId, 7);
    expect(collector.events).toHaveLength(2);

    harness.close();
  });

  it('reconnect restores all channels with no duplicate or missing listeners', async () => {
    const dbPath = makeDbPath('mm-rec-');
    const eventBus = new TelegramEventBus();
    const collector = new EventCollector();
    eventBus.subscribe(collector);
    const harness = openHarness(dbPath, eventBus);

    await harness.service.addBulkChannels(PROD8_CANON, [KEY_A, KEY_B]);
    await harness.listener.startAll(OWNER);

    collector.events.length = 0;
    for (let i = 0; i < PROD8_CANON.length; i++) {
      await deliver(harness, KEY_A, channelIdFor(harness, PROD8_CANON[i]!), PROD8_CANON[i]!, i + 1);
    }
    expect(collector.events).toHaveLength(8);

    await harness.listener.stopAll();
    const summary = await harness.listener.startAll(OWNER);
    expect(summary.active).toBe(16);
    expect(harness.listener.getDiagnosticSnapshot()).toHaveLength(16);
    for (const accountKey of [KEY_A, KEY_B]) {
      expect(harness.gateway.registrations.get(accountKey)?.size).toBe(8);
    }

    collector.events.length = 0;
    for (let i = 0; i < PROD8_CANON.length; i++) {
      for (const accountKey of [KEY_A, KEY_B]) {
        await deliver(harness, accountKey, channelIdFor(harness, PROD8_CANON[i]!), PROD8_CANON[i]!, 1000 + i);
      }
    }
    expect(collector.events).toHaveLength(16);
    verifyLiveEvents(collector, harness, PROD8_CANON, [KEY_A, KEY_B], (i) => 1000 + i);

    harness.close();
  });

  it('process restart restores all assignments and receives new live posts from DB', async () => {
    const dbPath = makeDbPath('mm-restart-');
    const eventBus1 = new TelegramEventBus();
    const collector1 = new EventCollector();
    eventBus1.subscribe(collector1);
    const harness1 = openHarness(dbPath, eventBus1);
    await harness1.service.addBulkChannels(PROD8_CANON, [KEY_A, KEY_B]);
    await harness1.listener.startAll(OWNER);
    for (let i = 0; i < PROD8_CANON.length; i++) {
      for (const accountKey of [KEY_A, KEY_B]) {
        await deliver(harness1, accountKey, channelIdFor(harness1, PROD8_CANON[i]!), PROD8_CANON[i]!, i + 1);
      }
    }
    expect(collector1.events).toHaveLength(16);
    harness1.close();

    const eventBus2 = new TelegramEventBus();
    const collector2 = new EventCollector();
    eventBus2.subscribe(collector2);
    const harness2 = openHarness(dbPath, eventBus2);
    const summary = await harness2.listener.startAll(OWNER);
    expect(summary.active).toBe(16);
    expect(harness2.listener.getDiagnosticSnapshot()).toHaveLength(16);
    for (const id of PROD8_CANON) {
      for (const accountKey of [KEY_A, KEY_B]) {
        verifyMonitoringCell(harness2, id, accountKey, false);
      }
    }

    collector2.events.length = 0;
    for (let i = 0; i < PROD8_CANON.length; i++) {
      for (const accountKey of [KEY_A, KEY_B]) {
        await deliver(harness2, accountKey, channelIdFor(harness2, PROD8_CANON[i]!), PROD8_CANON[i]!, 2000 + i);
      }
    }
    expect(collector2.events).toHaveLength(16);
    verifyLiveEvents(collector2, harness2, PROD8_CANON, [KEY_A, KEY_B], (i) => 2000 + i);

    harness2.close();
  });
});

function channelIdForOrNegative(harness: Harness, telegramChannelId: string): number {
  const channel = harness.repository.getByTelegramId(telegramChannelId);
  return channel?.id ?? -1;
}
