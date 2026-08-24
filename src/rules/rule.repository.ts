import type { DatabaseSync } from 'node:sqlite';

import type { RuleInput, RuleRecord } from './rule.types.js';

interface RuleRow {
  id: number;
  owner_id: number;
  channel_id: number | null;
  channel_title: string | null;
  reply_template_id: number | null;
  reply_template_name: string | null;
  reply_template_account_id: number | null;
  reply_template_account_key: string | null;
  reply_template_account_nickname: string | null;
  name: string;
  trigger_keywords: string;
  exclude_keywords: string;
  cleanup_sender_patterns: string;
  is_enabled: number;
  created_at: string;
  updated_at: string;
}

const SELECT_RULE = `
  SELECT
    r.id,
    r.owner_id,
    r.channel_id,
    c.title AS channel_title,
    r.reply_template_id,
    rt.name AS reply_template_name,
    rt.account_id AS reply_template_account_id,
    ta.session_key AS reply_template_account_key,
    ta.label AS reply_template_account_nickname,
    r.name,
    r.trigger_keywords,
    r.exclude_keywords,
    r.cleanup_sender_patterns,
    r.is_enabled,
    r.created_at,
    r.updated_at
  FROM rules r
  LEFT JOIN channels c ON c.id = r.channel_id
  LEFT JOIN reply_templates rt ON rt.id = r.reply_template_id
  LEFT JOIN accounts ta ON ta.id = rt.account_id
`;

export class RuleRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public list(ownerTelegramId: string): RuleRecord[] {
    return this.database.prepare(`${SELECT_RULE}
      WHERE r.owner_id = (SELECT id FROM owners WHERE telegram_user_id = ? AND is_active = 1)
        AND r.channel_id IS NOT NULL
      ORDER BY r.name COLLATE NOCASE, r.id
    `).all(ownerTelegramId).map((row) => mapRule(row as unknown as RuleRow));
  }

  public listEnabledByChannel(channelId: number): RuleRecord[] {
    return this.database.prepare(`${SELECT_RULE}
      WHERE r.channel_id = ? AND r.is_enabled = 1
      ORDER BY r.id
    `).all(channelId).map((row) => mapRule(row as unknown as RuleRow));
  }

  public get(ownerTelegramId: string, ruleId: number): RuleRecord | undefined {
    const row = this.database.prepare(`${SELECT_RULE}
      WHERE r.id = ?
        AND r.owner_id = (SELECT id FROM owners WHERE telegram_user_id = ? AND is_active = 1)
        AND r.channel_id IS NOT NULL
    `).get(ruleId, ownerTelegramId) as unknown as RuleRow | undefined;
    return row === undefined ? undefined : mapRule(row);
  }

  public findByName(ownerTelegramId: string, name: string, excludeId?: number): RuleRecord | undefined {
    const row = this.database.prepare(`${SELECT_RULE}
      WHERE r.name = ? COLLATE NOCASE
        AND r.owner_id = (SELECT id FROM owners WHERE telegram_user_id = ? AND is_active = 1)
        AND r.channel_id IS NOT NULL
        AND (? IS NULL OR r.id <> ?)
    `).get(name, ownerTelegramId, excludeId ?? null, excludeId ?? null) as unknown as RuleRow | undefined;
    return row === undefined ? undefined : mapRule(row);
  }

  public create(ownerTelegramId: string, input: RuleInput): RuleRecord {
    const result = this.database.prepare(`
      INSERT INTO rules (
        owner_id, channel_id, reply_template_id, name, trigger_keywords,
        exclude_keywords, cleanup_sender_patterns, is_enabled
      )
      SELECT id, ?, ?, ?, ?, ?, ?, 0
      FROM owners WHERE telegram_user_id = ? AND is_active = 1
    `).run(
      input.channelId,
      input.replyTemplateId ?? null,
      input.name,
      JSON.stringify(input.triggerKeywords),
      JSON.stringify(input.excludeKeywords),
      JSON.stringify(input.cleanupSenderPatterns),
      ownerTelegramId,
    );
    if (Number(result.changes) === 0) throw new Error('Active owner record was not found');
    return this.require(ownerTelegramId, Number(result.lastInsertRowid));
  }

  public update(ownerTelegramId: string, ruleId: number, input: RuleInput): RuleRecord {
    const result = this.database.prepare(`
      UPDATE rules SET
        channel_id = ?,
        reply_template_id = ?,
        name = ?,
        trigger_keywords = ?,
        exclude_keywords = ?,
        cleanup_sender_patterns = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND owner_id = (
        SELECT id FROM owners WHERE telegram_user_id = ? AND is_active = 1
      )
    `).run(
      input.channelId,
      input.replyTemplateId ?? null,
      input.name,
      JSON.stringify(input.triggerKeywords),
      JSON.stringify(input.excludeKeywords),
      JSON.stringify(input.cleanupSenderPatterns),
      ruleId,
      ownerTelegramId,
    );
    assertChanged(result.changes, 'Rule', ruleId);
    return this.require(ownerTelegramId, ruleId);
  }

  public setEnabled(ownerTelegramId: string, ruleId: number, enabled: boolean): RuleRecord {
    const result = this.database.prepare(`
      UPDATE rules SET is_enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND owner_id = (
        SELECT id FROM owners WHERE telegram_user_id = ? AND is_active = 1
      )
    `).run(enabled ? 1 : 0, ruleId, ownerTelegramId);
    assertChanged(result.changes, 'Rule', ruleId);
    return this.require(ownerTelegramId, ruleId);
  }

  public remove(ownerTelegramId: string, ruleId: number): void {
    const result = this.database.prepare(`
      DELETE FROM rules WHERE id = ? AND owner_id = (
        SELECT id FROM owners WHERE telegram_user_id = ? AND is_active = 1
      )
    `).run(ruleId, ownerTelegramId);
    assertChanged(result.changes, 'Rule', ruleId);
  }

  private require(ownerTelegramId: string, ruleId: number): RuleRecord {
    const rule = this.get(ownerTelegramId, ruleId);
    if (rule === undefined) throw new Error(`Rule not found: ${ruleId}`);
    return rule;
  }
}

function mapRule(row: RuleRow): RuleRecord {
  if (row.channel_id === null || row.channel_title === null) {
    throw new Error(`Rule ${row.id} has no valid channel scope`);
  }
  return {
    id: row.id,
    ownerId: row.owner_id,
    channelId: row.channel_id,
    channelTitle: row.channel_title,
    ...(row.reply_template_id === null ? {} : { replyTemplateId: row.reply_template_id }),
    ...(row.reply_template_name === null ? {} : { replyTemplateName: row.reply_template_name }),
    ...(row.reply_template_account_id === null
      ? {}
      : { replyTemplateAccountId: row.reply_template_account_id }),
    ...(row.reply_template_account_key === null
      ? {}
      : { replyTemplateAccountKey: row.reply_template_account_key }),
    ...(row.reply_template_account_nickname === null
      ? {}
      : { replyTemplateAccountNickname: row.reply_template_account_nickname }),
    name: row.name,
    triggerKeywords: parseStringArray(row.trigger_keywords),
    excludeKeywords: parseStringArray(row.exclude_keywords),
    cleanupSenderPatterns: parseStringArray(row.cleanup_sender_patterns),
    enabled: row.is_enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseStringArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error('Stored rule keywords are invalid');
  }
  const values: unknown[] = parsed;
  if (values.some((item) => typeof item !== 'string')) {
    throw new Error('Stored rule keywords are invalid');
  }
  return values.map((item) => {
    if (typeof item !== 'string') throw new Error('Stored rule keyword is invalid');
    return item;
  });
}

function assertChanged(changes: number | bigint, label: string, id: number): void {
  if (Number(changes) === 0) throw new Error(`${label} not found: ${id}`);
}
