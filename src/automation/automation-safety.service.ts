import type { DatabaseSync } from 'node:sqlite';

import { ChannelService } from '../channels/channel.service.js';
import { EventLogRepository } from '../logging/event-log.repository.js';
import type { AppLogger } from '../logging/logger.js';

const GLOBAL_AUTOMATION_KEY = 'global_automation_enabled';

export class AutomationSafetyService {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly channels: ChannelService,
    private readonly eventLogs: EventLogRepository,
    private readonly logger: AppLogger,
  ) {}

  public isAutomationEnabled(): boolean {
    const row = this.database.prepare('SELECT value FROM settings WHERE key = ?')
      .get(GLOBAL_AUTOMATION_KEY) as { value: string } | undefined;
    return row === undefined ? true : JSON.parse(row.value) === true;
  }

  public getStatus(): { readonly enabled: boolean } {
    return { enabled: this.isAutomationEnabled() };
  }

  public async stopAll(): Promise<void> {
    this.setGlobalEnabled(false);
    this.cancelScheduled(undefined, 'global_stop_all');
    await this.channels.stopListeners();
    this.recordGlobal('automation_stop_all', 'stopped', 'owner_emergency_stop');
  }

  public async resumeAll(): Promise<void> {
    this.setGlobalEnabled(true);
    await this.channels.startListeners();
    this.recordGlobal('automation_resume_all', 'resumed', 'owner_manual_resume');
  }

  public async blockChannel(channelId: number, reason: string): Promise<boolean> {
    const current = this.channels.getChannel(channelId);
    if (current.channel.automationBlocked === true) return false;
    this.cancelScheduled(channelId, 'channel_cleanup_blocked');
    await this.channels.blockAutomation(channelId, reason);
    return true;
  }

  public async resumeChannel(channelId: number): Promise<void> {
    const detail = await this.channels.resumeAutomation(channelId);
    this.eventLogs.record({
      level: 'info',
      eventType: 'channel_resumed',
      channelId,
      action: 'channel_resumed',
      status: 'resumed',
      reason: 'owner_manual_resume',
    });
    this.logger.info(
      { channel: channelId, action: 'channel_resumed', status: 'resumed' },
      `Automation resumed for ${detail.channel.title}`,
    );
  }

  private setGlobalEnabled(enabled: boolean): void {
    this.database.prepare(`
      INSERT INTO settings (key, value, description)
      VALUES (?, ?, 'Persistent emergency STOP/RESUME state for M5 auto reply execution')
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `).run(GLOBAL_AUTOMATION_KEY, JSON.stringify(enabled));
  }

  private cancelScheduled(channelId: number | undefined, reason: string): void {
    this.database.prepare(`
      UPDATE automation_dispatches SET
        status = 'limit_skipped',
        error_reason = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE status = 'scheduled' AND (? IS NULL OR channel_id = ?)
    `).run(reason, channelId ?? null, channelId ?? null);
  }

  private recordGlobal(eventType: string, status: string, reason: string): void {
    this.eventLogs.record({
      level: 'warn',
      eventType,
      action: eventType,
      status,
      reason,
    });
    this.logger.warn({ action: eventType, status, reason }, 'Global automation state changed');
  }
}
