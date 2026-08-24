import type { AppLogger } from '../logging/logger.js';
import { AccountAutomationSettingsRepository } from './account-automation-settings.repository.js';
import type { AccountAutomationSettings } from './automation.types.js';

export class AccountAutomationSettingsService {
  public constructor(
    private readonly repository: AccountAutomationSettingsRepository,
    private readonly ownerTelegramId: string,
    private readonly logger: AppLogger,
  ) {}

  public get(accountKey: string): AccountAutomationSettings {
    const settings = this.repository.get(this.ownerTelegramId, accountKey);
    if (settings === undefined) throw new Error(`Account not found: ${accountKey}`);
    return settings;
  }

  public setReplyDelay(accountKey: string, seconds: string): AccountAutomationSettings {
    const replyDelayMs = parseSecondsToMilliseconds(seconds, 'Reply delay', 600);
    return this.update(accountKey, { replyDelayMs }, 'reply_delay_updated');
  }

  public setAutoReaction(accountKey: string, enabled: boolean): AccountAutomationSettings {
    return this.update(accountKey, { autoReaction: enabled }, 'auto_reaction_updated');
  }

  public setCooldown(accountKey: string, seconds: string): AccountAutomationSettings {
    const cooldownMs = parseSecondsToMilliseconds(seconds, 'Cooldown', 86_400);
    return this.update(accountKey, { cooldownMs }, 'cooldown_updated');
  }

  public setHourlyLimit(accountKey: string, value: string): AccountAutomationSettings {
    return this.update(
      accountKey,
      { hourlyLimit: parseLimit(value, 'Hourly limit') },
      'hourly_limit_updated',
    );
  }

  public setDailyLimit(accountKey: string, value: string): AccountAutomationSettings {
    return this.update(
      accountKey,
      { dailyLimit: parseLimit(value, 'Daily limit') },
      'daily_limit_updated',
    );
  }

  public setNotificationTarget(accountKey: string, value: string): AccountAutomationSettings {
    const notificationTarget = parseNotificationTarget(value);
    return this.update(accountKey, { notificationTarget }, 'notification_target_updated');
  }

  private update(
    accountKey: string,
    input: Parameters<AccountAutomationSettingsRepository['update']>[2],
    action: string,
  ): AccountAutomationSettings {
    const settings = this.repository.update(this.ownerTelegramId, accountKey, input);
    this.logger.info(
      { account: accountKey, action, status: 'updated' },
      'Account auto reply settings updated',
    );
    return settings;
  }
}

export function parseSecondsToMilliseconds(
  input: string,
  label: string,
  maximumSeconds: number,
): number {
  const normalized = input.trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    throw new Error(`${label} must be a non-negative number`);
  }
  const seconds = Number(normalized);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  if (seconds > maximumSeconds) {
    throw new Error(`${label} must not exceed ${maximumSeconds} seconds`);
  }
  return Math.round(seconds * 1_000);
}

function parseLimit(input: string, label: string): number {
  const normalized = input.trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be a non-negative integer`);
  const value = Number(normalized);
  if (!Number.isSafeInteger(value) || value > 100_000) {
    throw new Error(`${label} must be between 0 and 100000`);
  }
  return value;
}

export function parseNotificationTarget(input: string): string | null {
  const normalized = input.trim();
  if (normalized === '-' || normalized.length === 0) return null;
  if (/^@[A-Za-z][A-Za-z0-9_]{4,31}bot$/i.test(normalized)) return normalized;
  if (/^-?\d+$/.test(normalized)) return normalized;
  throw new Error('Notification target must be a bot username (for example @MonitorBot) or numeric Telegram ID; send - to disable');
}
