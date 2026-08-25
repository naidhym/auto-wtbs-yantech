import fs from 'node:fs';
import path from 'node:path';

export interface TelegramChannelSyncStateRecord {
  readonly accountId: number;
  readonly channelId: number;
  readonly pts: number;
  readonly syncStatus: 'pending' | 'healthy' | 'recovering' | 'error';
  readonly lastSuccessfulSyncAt?: string;
  readonly lastAttemptedSyncAt?: string;
  readonly lastError?: string;
}

interface PersistedStateFile {
  readonly channels: Record<string, TelegramChannelSyncStateRecord>;
}

export class TelegramChannelSyncStateStore {
  private readonly filePath: string;

  public constructor(accountDirectory: string) {
    fs.mkdirSync(accountDirectory, { recursive: true, mode: 0o700 });
    this.filePath = path.join(accountDirectory, 'telegram-channel-sync-state.json');
  }

  public get(accountId: number, channelId: number): TelegramChannelSyncStateRecord | undefined {
    return this.read().channels[this.key(accountId, channelId)];
  }

  public ensure(accountId: number, channelId: number): TelegramChannelSyncStateRecord {
    const existing = this.get(accountId, channelId);
    if (existing !== undefined) return existing;
    const created: TelegramChannelSyncStateRecord = {
      accountId,
      channelId,
      pts: 1,
      syncStatus: 'pending',
    };
    this.writeRecord(created);
    return created;
  }

  public markRecovering(accountId: number, channelId: number): TelegramChannelSyncStateRecord {
    const current = this.ensure(accountId, channelId);
    const next: TelegramChannelSyncStateRecord = {
      accountId: current.accountId,
      channelId: current.channelId,
      pts: current.pts,
      syncStatus: 'recovering',
      ...(current.lastSuccessfulSyncAt === undefined ? {} : { lastSuccessfulSyncAt: current.lastSuccessfulSyncAt }),
      lastAttemptedSyncAt: new Date().toISOString(),
    };
    this.writeRecord(next);
    return next;
  }

  public markHealthy(accountId: number, channelId: number, pts: number): TelegramChannelSyncStateRecord {
    const current = this.ensure(accountId, channelId);
    const now = new Date().toISOString();
    const next: TelegramChannelSyncStateRecord = {
      accountId: current.accountId,
      channelId: current.channelId,
      pts,
      syncStatus: 'healthy',
      lastAttemptedSyncAt: now,
      lastSuccessfulSyncAt: now,
    };
    this.writeRecord(next);
    return next;
  }

  public markError(accountId: number, channelId: number, message: string): TelegramChannelSyncStateRecord {
    const current = this.ensure(accountId, channelId);
    const next: TelegramChannelSyncStateRecord = {
      ...current,
      syncStatus: 'error',
      lastAttemptedSyncAt: new Date().toISOString(),
      lastError: message,
    };
    this.writeRecord(next);
    return next;
  }

  private key(accountId: number, channelId: number): string {
    return `${accountId}:${channelId}`;
  }

  private read(): PersistedStateFile {
    if (!fs.existsSync(this.filePath)) {
      return { channels: {} };
    }
    return JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as PersistedStateFile;
  }

  private writeRecord(record: TelegramChannelSyncStateRecord): void {
    const current = this.read();
    current.channels[this.key(record.accountId, record.channelId)] = record;
    fs.writeFileSync(this.filePath, JSON.stringify(current, null, 2), { encoding: 'utf8', mode: 0o600 });
  }
}
