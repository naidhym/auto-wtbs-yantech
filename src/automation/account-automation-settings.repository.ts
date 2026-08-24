import type { DatabaseSync } from 'node:sqlite';

import type { AccountAutomationSettings } from './automation.types.js';

interface SettingsRow {
  account_id: number;
  session_key: string;
  label: string;
  reply_delay_ms: number;
  auto_reaction: number;
  cooldown_ms: number;
  hourly_limit: number;
  daily_limit: number;
  notification_target: string | null;
  updated_at: string;
}

const SELECT_SETTINGS = `
  SELECT
    s.account_id,
    a.session_key,
    a.label,
    s.reply_delay_ms,
    s.auto_reaction,
    s.cooldown_ms,
    s.hourly_limit,
    s.daily_limit,
    s.notification_target,
    s.updated_at
  FROM account_automation_settings s
  JOIN accounts a ON a.id = s.account_id
  JOIN owners o ON o.id = a.owner_id
`;

export class AccountAutomationSettingsRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public get(ownerTelegramId: string, accountKey: string): AccountAutomationSettings | undefined {
    this.ensure(ownerTelegramId, accountKey);
    const row = this.database.prepare(`${SELECT_SETTINGS}
      WHERE a.session_key = ? AND o.telegram_user_id = ? AND o.is_active = 1
    `).get(accountKey, ownerTelegramId) as unknown as SettingsRow | undefined;
    return row === undefined ? undefined : mapSettings(row);
  }

  public update(
    ownerTelegramId: string,
    accountKey: string,
    input: {
      readonly replyDelayMs?: number;
      readonly autoReaction?: boolean;
      readonly cooldownMs?: number;
      readonly hourlyLimit?: number;
      readonly dailyLimit?: number;
      readonly notificationTarget?: string | null;
    },
  ): AccountAutomationSettings {
    this.ensure(ownerTelegramId, accountKey);
    const result = this.database.prepare(`
      UPDATE account_automation_settings SET
        reply_delay_ms = COALESCE(?, reply_delay_ms),
        auto_reaction = COALESCE(?, auto_reaction),
        cooldown_ms = COALESCE(?, cooldown_ms),
        hourly_limit = COALESCE(?, hourly_limit),
        daily_limit = COALESCE(?, daily_limit),
        notification_target = CASE WHEN ? = 1 THEN ? ELSE notification_target END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE account_id = (
        SELECT a.id FROM accounts a
        JOIN owners o ON o.id = a.owner_id
        WHERE a.session_key = ? AND o.telegram_user_id = ? AND o.is_active = 1
      )
    `).run(
      input.replyDelayMs ?? null,
      input.autoReaction === undefined ? null : input.autoReaction ? 1 : 0,
      input.cooldownMs ?? null,
      input.hourlyLimit ?? null,
      input.dailyLimit ?? null,
      input.notificationTarget === undefined ? 0 : 1,
      input.notificationTarget ?? null,
      accountKey,
      ownerTelegramId,
    );
    if (Number(result.changes) === 0) throw new Error(`Account not found: ${accountKey}`);
    const settings = this.get(ownerTelegramId, accountKey);
    if (settings === undefined) throw new Error(`Account settings not found: ${accountKey}`);
    return settings;
  }

  private ensure(ownerTelegramId: string, accountKey: string): void {
    this.database.prepare(`
      INSERT OR IGNORE INTO account_automation_settings (account_id)
      SELECT a.id FROM accounts a
      JOIN owners o ON o.id = a.owner_id
      WHERE a.session_key = ? AND o.telegram_user_id = ? AND o.is_active = 1
    `).run(accountKey, ownerTelegramId);
  }
}

function mapSettings(row: SettingsRow): AccountAutomationSettings {
  return {
    accountId: row.account_id,
    accountKey: row.session_key,
    accountNickname: row.label,
    replyDelayMs: row.reply_delay_ms,
    autoReaction: row.auto_reaction === 1,
    cooldownMs: row.cooldown_ms,
    hourlyLimit: row.hourly_limit,
    dailyLimit: row.daily_limit,
    ...(row.notification_target === null ? {} : { notificationTarget: row.notification_target }),
    updatedAt: row.updated_at,
  };
}
