import type { DatabaseSync } from 'node:sqlite';

export interface ActionReportRecord {
  readonly id: number;
  readonly createdAt: string;
  readonly eventType: 'reply_sent' | 'reply_failed';
  readonly status: string;
  readonly reason?: string;
  readonly accountNickname: string;
  readonly channelTitle: string;
  readonly metadata: Record<string, unknown>;
}

export class EventLogRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public record(input: {
    readonly level: 'debug' | 'info' | 'warn' | 'error';
    readonly eventType: string;
    readonly accountId?: number;
    readonly channelId?: number;
    readonly ruleId?: number;
    readonly action: string;
    readonly status: string;
    readonly reason?: string;
    readonly excludeKeyword?: string;
    readonly metadata?: Record<string, unknown>;
  }): void {
    this.database.prepare(`
      INSERT INTO logs (
        level, event_type, account_id, channel_id, rule_id, action, status,
        error_reason, exclude_keyword, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.level,
      input.eventType,
      input.accountId ?? null,
      input.channelId ?? null,
      input.ruleId ?? null,
      input.action,
      input.status,
      input.reason ?? null,
      input.excludeKeyword ?? null,
      input.metadata === undefined ? null : JSON.stringify(input.metadata),
    );
  }

  public listActionReports(ownerTelegramId: string, offset: number, limit: number): ActionReportRecord[] {
    return this.database.prepare(`
      SELECT l.id, l.created_at, l.event_type, l.status, l.error_reason,
        a.label AS account_nickname, c.title AS channel_title, l.metadata
      FROM logs l
      JOIN accounts a ON a.id = l.account_id
      JOIN owners o ON o.id = a.owner_id
      JOIN channels c ON c.id = l.channel_id
      WHERE o.telegram_user_id = ? AND o.is_active = 1
        AND l.event_type IN ('reply_sent', 'reply_failed')
      ORDER BY l.id DESC LIMIT ? OFFSET ?
    `).all(ownerTelegramId, limit, offset).map((row) => {
      const value = row as unknown as {
        id: number; created_at: string; event_type: 'reply_sent' | 'reply_failed'; status: string;
        error_reason: string | null; account_nickname: string; channel_title: string; metadata: string | null;
      };
      return {
        id: value.id,
        createdAt: value.created_at,
        eventType: value.event_type,
        status: value.status,
        ...(value.error_reason === null ? {} : { reason: value.error_reason }),
        accountNickname: value.account_nickname,
        channelTitle: value.channel_title,
        metadata: value.metadata === null ? {} : parseMetadata(value.metadata),
      };
    });
  }
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
