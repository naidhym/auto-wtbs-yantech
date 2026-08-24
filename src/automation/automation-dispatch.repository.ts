import type { DatabaseSync } from 'node:sqlite';

import type { ReactionStatus } from './automation.types.js';

export interface DispatchClaim {
  readonly id: number;
  readonly accountId: number;
  readonly channelId: number;
  readonly templateId: number;
  readonly sourceMessageId: number;
  readonly matchedTrigger: string;
  readonly delayMs: number;
}

export class AutomationDispatchRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public claim(input: Omit<DispatchClaim, 'id'>): DispatchClaim | undefined {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO automation_dispatches (
        account_id, channel_id, reply_template_id, source_message_id,
        matched_trigger, delay_ms, status
      ) VALUES (?, ?, ?, ?, ?, ?, 'scheduled')
    `).run(
      input.accountId,
      input.channelId,
      input.templateId,
      input.sourceMessageId,
      input.matchedTrigger,
      input.delayMs,
    );
    if (Number(result.changes) === 0) return undefined;
    return { ...input, id: Number(result.lastInsertRowid) };
  }

  public latestSentAt(accountId: number): string | undefined {
    const row = this.database.prepare(`
      SELECT sent_at FROM automation_dispatches
      WHERE account_id = ? AND status = 'sent' AND sent_at IS NOT NULL
      ORDER BY sent_at DESC, id DESC LIMIT 1
    `).get(accountId) as { sent_at: string } | undefined;
    return row?.sent_at;
  }

  public isScheduled(dispatchId: number): boolean {
    return this.database.prepare(`
      SELECT 1 AS present FROM automation_dispatches
      WHERE id = ? AND status = 'scheduled'
    `).get(dispatchId) !== undefined;
  }

  public countSentSince(accountId: number, since: string): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM automation_dispatches
      WHERE account_id = ? AND status = 'sent' AND sent_at >= ?
    `).get(accountId, since) as { count: number };
    return row.count;
  }

  public markSkipped(
    dispatchId: number,
    status: 'cooldown_skipped' | 'limit_skipped',
    reason: string,
  ): void {
    this.database.prepare(`
      UPDATE automation_dispatches SET status = ?, error_reason = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND status = 'scheduled'
    `).run(status, reason, dispatchId);
  }

  public markSent(
    dispatchId: number,
    replyMessageId: number,
  ): void {
    this.database.prepare(`
      UPDATE automation_dispatches SET
        status = 'sent',
        reply_message_id = ?,
        error_reason = NULL,
        sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND status = 'scheduled'
    `).run(replyMessageId, dispatchId);
  }

  public setReplyMessageLink(dispatchId: number, messageLink: string): void {
    this.database.prepare(`
      UPDATE automation_dispatches SET
        reply_message_link = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND status = 'sent'
    `).run(messageLink, dispatchId);
  }

  public setReactionStatus(
    dispatchId: number,
    reactionStatus: ReactionStatus,
    reactionReason?: string,
  ): void {
    this.database.prepare(`
      UPDATE automation_dispatches SET
        reaction_status = ?,
        error_reason = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND status = 'sent'
    `).run(reactionStatus, reactionReason ?? null, dispatchId);
  }

  public markFailed(dispatchId: number, reason: string): void {
    this.database.prepare(`
      UPDATE automation_dispatches SET status = 'failed', error_reason = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND status = 'scheduled'
    `).run(reason, dispatchId);
  }
}
