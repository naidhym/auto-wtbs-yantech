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
  ChannelRecord,
  ResolvedTelegramChannel,
} from '../src/channels/channel.types.js';
import type { TelegramIncomingMessage } from '../src/rules/rule.types.js';
import { DatabaseService } from '../src/database/database.service.js';
import { createLogger, type LoggerHandle } from '../src/logging/logger.js';
import {
  parseChannelInputText,
  splitChannelInputLines,
} from '../src/shared/bulk-channel-parser.js';
import { toCanonicalChannelId } from '../src/shared/telegram-channel-id.js';

const OWNER = '123456789';
const KEY_A = 'account-00000000-0000-4000-8000-000000000701';
const KEY_B = 'account-00000000-0000-4000-8000-000000000702';

const PRODUCTION_INPUT = [
  '1611324665',
  '3980589729',
  '1303979309',
  '1441823150',
  '1202510480',
  '1274048263',
  '4436049182',
  '1525948158',
].join('\n');

class DistinctChannelGateway implements ChannelAccessGateway {
  public readonly resolutions: Array<{ accountKey: string; identifier: string }> = [];
  public readonly failIdentifiers = new Set<string>();

  public resolve(accountKey: string, identifier: string): Promise<ResolvedTelegramChannel> {
    this.resolutions.push({ accountKey, identifier });
    if (this.failIdentifiers.has(identifier)) {
      return Promise.reject(new Error('CHANNEL_PRIVATE'));
    }
    const trimmed = identifier.trim();
    const resolved: ResolvedTelegramChannel = /^-?\d+$/.test(trimmed)
      ? { telegramChannelId: toCanonicalChannelId(trimmed), title: `Channel ${toCanonicalChannelId(trimmed)}` }
      : (() => {
          const slug = trimmed.replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '').replace(/\W/g, '').toLowerCase();
          return { telegramChannelId: slug, title: slug, username: slug };
        })();
    return Promise.resolve(resolved);
  }

  public subscribe(
    accountKey: string,
    _assignment: ChannelAssignmentRecord,
    channel: ChannelRecord,
    _onMessage: (event: TelegramIncomingMessage) => Promise<void>,
    onError: (error: unknown) => Promise<void> | void,
  ): Promise<() => Promise<void>> {
    void _onMessage;
    const key = `${accountKey}:${channel.id}`;
    return Promise.resolve(() => {
      void key;
      void onError;
      return Promise.resolve();
    });
  }
}

function createHarness(): {
  service: ChannelService;
  gateway: DistinctChannelGateway;
  close(): void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-wtb-bulk-'));
  const logger: LoggerHandle = createLogger({
    level: 'error',
    logDirectory: path.join(root, 'logs'),
    environment: 'test',
    writeToStdout: false,
  });
  const database = new DatabaseService(path.join(root, 'db.sqlite'), logger.logger);
  database.initialize();
  database.ensureOwner(OWNER);
  const connection: DatabaseSync = database.getConnection();
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
  const gateway = new DistinctChannelGateway();
  const listener = new ChannelListenerService(repository, gateway, logger.logger);
  const service = new ChannelService(repository, accounts, OWNER, gateway, listener, logger.logger);
  return {
    service,
    gateway,
    close(): void {
      database.close();
      logger.close();
    },
  };
}

describe('multiline channel input splitting', () => {
  it('splits one numeric input into a single identifier', () => {
    expect(splitChannelInputLines('1611324665')).toEqual(['1611324665']);
  });

  it('splits multiple numeric inputs on separate lines', () => {
    expect(splitChannelInputLines(PRODUCTION_INPUT)).toEqual([
      '1611324665',
      '3980589729',
      '1303979309',
      '1441823150',
      '1202510480',
      '1274048263',
      '4436049182',
      '1525948158',
    ]);
  });

  it('ignores blank lines', () => {
    expect(splitChannelInputLines('@a\n\n  \n@b')).toEqual(['@a', '@b']);
  });

  it('trims surrounding whitespace on each line', () => {
    expect(splitChannelInputLines('  @a  \n\t@b\n')).toEqual(['@a', '@b']);
  });
});

describe('parseChannelInputText (production bulk input)', () => {
  it('treats a multiline string as many identifiers, never as one', () => {
    const result = parseChannelInputText(PRODUCTION_INPUT);
    expect(result.valid).toHaveLength(8);
    expect(result.invalid).toHaveLength(0);
    expect(result.valid.some((item) => item.normalized === PRODUCTION_INPUT)).toBe(false);
    expect(result.valid.map((item) => item.normalized)).toEqual([
      '1611324665',
      '3980589729',
      '1303979309',
      '1441823150',
      '1202510480',
      '1274048263',
      '4436049182',
      '1525948158',
    ]);
  });

  it('parses multiple usernames', () => {
    const result = parseChannelInputText('@alpha\n@betab\n@gammaz');
    expect(result.valid.map((item) => item.normalized)).toEqual(['alpha', 'betab', 'gammaz']);
  });

  it('parses multiple public t.me links', () => {
    const result = parseChannelInputText('https://t.me/alpha\nhttps://t.me/betab');
    expect(result.valid.map((item) => item.normalized)).toEqual(['alpha', 'betab']);
  });

  it('handles mixed valid and invalid input', () => {
    const result = parseChannelInputText('@alpha\nnot a channel\n@betab');
    expect(result.valid.map((item) => item.normalized)).toEqual(['alpha', 'betab']);
    expect(result.invalid).toHaveLength(1);
  });

  it('deduplicates repeated lines', () => {
    const result = parseChannelInputText('@alpha\n@alpha\n@betab');
    expect(result.valid.map((item) => item.normalized)).toEqual(['alpha', 'betab']);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]!.reason).toContain('Duplicate');
  });

  it('deduplicates the same channel across formats after canonicalization', () => {
    const result = parseChannelInputText('1611324665\n-1001611324665');
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0]!.normalized).toBe('1611324665');
    expect(result.invalid).toHaveLength(1);
  });
});

describe('bulk channel creation and assignment', () => {
  it('single-channel addChannel flow still works', async () => {
    const harness = createHarness();
    const detail = await harness.service.addChannel('@alpha', KEY_A);
    expect(detail.channel.title).toBe('alpha');
    expect(harness.service.listChannels()).toHaveLength(1);
    harness.close();
  });

  it('creates all valid channels in a bulk import', async () => {
    const harness = createHarness();
    const result = await harness.service.addBulkChannels(
      ['@alpha', '@betab', '@gammaz'],
      [KEY_A],
    );
    expect(result.failed).toHaveLength(0);
    expect(result.created).toHaveLength(3);
    expect(harness.service.listChannels()).toHaveLength(3);
    harness.close();
  });

  it('assigns bulk channels to selected account(s)', async () => {
    const harness = createHarness();
    const result = await harness.service.addBulkChannels(
      ['@alpha', '@betab'],
      [KEY_A, KEY_B],
    );
    expect(result.assigned).toHaveLength(4);
    expect(result.failed).toHaveLength(0);
    const channel = harness.service.listChannels()[0]!;
    const assignments = harness.service.getChannel(channel.id).assignments;
    expect(assignments.map((item) => item.accountKey).sort()).toEqual([KEY_A, KEY_B]);
    harness.close();
  });

  it('does not abort the batch when one channel is invalid', async () => {
    const harness = createHarness();
    harness.gateway.failIdentifiers.add('@broken');
    const result = await harness.service.addBulkChannels(
      ['@alpha', '@broken', '@betab'],
      [KEY_A],
    );
    expect(result.created).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.identifier).toBe('@broken');
    expect(harness.service.listChannels()).toHaveLength(2);
    harness.close();
  });

  it('imports the 8-channel production payload into 8 independent channels', async () => {
    const harness = createHarness();
    const parsed = parseChannelInputText(PRODUCTION_INPUT);
    const result = await harness.service.addBulkChannels(
      parsed.valid.map((item) => item.normalized),
      [KEY_A],
    );
    expect(result.failed).toHaveLength(0);
    expect(result.created).toHaveLength(8);
    expect(harness.service.listChannels()).toHaveLength(8);
    harness.close();
  });
});

describe('bulk channel resolution preview', () => {
  it('reports a new channel as resolvable (not existing)', async () => {
    const harness = createHarness();
    const preview = await harness.service.resolveChannelPreview('@alpha', KEY_A);
    expect(preview.resolved.telegramChannelId).toBe('alpha');
    expect(preview.existing).toBeUndefined();
    harness.close();
  });

  it('reports an already-imported channel as existing', async () => {
    const harness = createHarness();
    await harness.service.addChannel('@alpha', KEY_A);
    const preview = await harness.service.resolveChannelPreview('@alpha', KEY_A);
    expect(preview.existing).toBeDefined();
    expect(preview.existing!.title).toBe('alpha');
    harness.close();
  });
});
