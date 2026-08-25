import type { DatabaseSync } from 'node:sqlite';

export interface TelegramChannelSyncStateRecord {
  readonly accountId: number;
  readonly channelId: number;
  readonly pts: number;
  readonly syncStatus: 'pending' | 'healthy' | 'recovering' | 'error';
  readonly lastSuccessfulSyncAt?: string;
  readonly lastAttemptedSyncAt?: string;
  readonly lastError?: string;
}

interface SyncStateRow {
  readonly account_id: number;
  readonly channel_id: number;
  readonly pts: number;
  readonly sync_status: TelegramChannelSyncStateRecord['syncStatus'];
  readonly last_successful_sync_at: string | null;
  readonly last_attempted_sync_at: string | null;
  readonly last_error: string | null;
}

export class TelegramChannelSyncStateRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public get(accountId: number, channelId: number): TelegramChannelSyncStateRecord | undefined {
    const row = this.database.prepare(`
      SELECT account_id, channel_id, pts, sync_status, last_successful_sync_at, last_attempted_sync_at, last_error
      FROM telegram_channel_sync_state
      WHERE account_id = ? AND channel_id = ?
    `).get(accountId, channelId) as unknown as SyncStateRow | undefined;
    return row === undefined ? undefined : mapRow(row);
  }

  public listForAccount(accountId: number): TelegramChannelSyncStateRecord[] {
    return this.database.prepare(`
      SELECT account_id, channel_id, pts, sync_status, last_successful_sync_at, last_attempted_sync_at, last_error
      FROM telegram_channel_sync_state
      WHERE account_id = ?
      ORDER BY channel_id, account_id
    `).all(accountId).map((row) => mapRow(row as unknown as SyncStateRow));
  }

  public ensure(accountId: number, channelId: number): TelegramChannelSyncStateRecord {
    this.database.prepare(`
      INSERT INTO telegram_channel_sync_state (account_id, channel_id)
      VALUES (?, ?)
      ON CONFLICT(account_id, channel_id) DO NOTHING
    `).run(accountId, channelId);
    return this.require(accountId, channelId);
  }

  public markRecovering(accountId: number, channelId: number): TelegramChannelSyncStateRecord {
    this.ensure(accountId, channelId);
    this.database.prepare(`
      UPDATE telegram_channel_sync_state
      SET sync_status = 'recovering',
          last_attempted_sync_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          last_error = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE account_id = ? AND channel_id = ?
    `).run(accountId, channelId);
    return this.require(accountId, channelId);
  }

  public markHealthy(accountId: number, channelId: number, pts: number): TelegramChannelSyncStateRecord {
    this.ensure(accountId, channelId);
    this.database.prepare(`
      UPDATE telegram_channel_sync_state
      SET pts = ?,
          sync_status = 'healthy',
          last_successful_sync_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          last_attempted_sync_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          last_error = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE account_id = ? AND channel_id = ?
    `).run(pts, accountId, channelId);
    return this.require(accountId, channelId);
  }

  public markError(accountId: number, channelId: number, message: string): TelegramChannelSyncStateRecord {
    this.ensure(accountId, channelId);
    this.database.prepare(`
      UPDATE telegram_channel_sync_state
      SET sync_status = 'error',
          last_attempted_sync_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          last_error = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE account_id = ? AND channel_id = ?
    `).run(message, accountId, channelId);
    return this.require(accountId, channelId);
  }

  public remove(accountId: number, channelId: number): void {
    this.database.prepare('DELETE FROM telegram_channel_sync_state WHERE account_id = ? AND channel_id = ?')
      .run(accountId, channelId);
  }

  private require(accountId: number, channelId: number): TelegramChannelSyncStateRecord {
    const record = this.get(accountId, channelId);
    if (record === undefined) {
      throw new Error(`Telegram channel sync state not found for account ${accountId} and channel ${channelId}`);
    }
    return record;
  }
}

function mapRow(row: SyncStateRow): TelegramChannelSyncStateRecord {
  return {
    accountId: row.account_id,
    channelId: row.channel_id,
    pts: row.pts,
    syncStatus: row.sync_status,
    ...(row.last_successful_sync_at === null ? {} : { lastSuccessfulSyncAt: row.last_successful_sync_at }),
    ...(row.last_attempted_sync_at === null ? {} : { lastAttemptedSyncAt: row.last_attempted_sync_at }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
  };
}
