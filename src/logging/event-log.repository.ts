import type { DatabaseSync } from 'node:sqlite';

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
}
