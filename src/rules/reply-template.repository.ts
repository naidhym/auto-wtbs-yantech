import type { DatabaseSync } from 'node:sqlite';

import type { ReplyTemplateRecord } from './rule.types.js';

interface TemplateRow {
  id: number;
  account_id: number;
  session_key: string;
  account_label: string;
  name: string;
  body: string;
  is_enabled: number;
  created_at: string;
  updated_at: string;
}

const SELECT_TEMPLATE = `
  SELECT
    rt.id,
    rt.account_id,
    a.session_key,
    a.label AS account_label,
    rt.name,
    rt.body,
    rt.is_enabled,
    rt.created_at,
    rt.updated_at
  FROM reply_templates rt
  JOIN accounts a ON a.id = rt.account_id
  JOIN owners o ON o.id = a.owner_id
`;

export class ReplyTemplateRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public list(ownerTelegramId: string, accountKey: string): ReplyTemplateRecord[] {
    return this.database.prepare(`${SELECT_TEMPLATE}
      WHERE a.session_key = ? AND o.telegram_user_id = ? AND o.is_active = 1
      ORDER BY rt.name COLLATE NOCASE, rt.id
    `).all(accountKey, ownerTelegramId)
      .map((row) => mapTemplate(row as unknown as TemplateRow));
  }

  public listForOwner(ownerTelegramId: string): ReplyTemplateRecord[] {
    return this.database.prepare(`${SELECT_TEMPLATE}
      WHERE o.telegram_user_id = ? AND o.is_active = 1
      ORDER BY a.label COLLATE NOCASE, a.id, rt.name COLLATE NOCASE, rt.id
    `).all(ownerTelegramId).map((row) => mapTemplate(row as unknown as TemplateRow));
  }

  public get(
    ownerTelegramId: string,
    accountKey: string,
    templateId: number,
  ): ReplyTemplateRecord | undefined {
    const row = this.database.prepare(`${SELECT_TEMPLATE}
      WHERE rt.id = ? AND a.session_key = ?
        AND o.telegram_user_id = ? AND o.is_active = 1
    `).get(templateId, accountKey, ownerTelegramId) as unknown as TemplateRow | undefined;
    return row === undefined ? undefined : mapTemplate(row);
  }

  public getForOwner(
    ownerTelegramId: string,
    templateId: number,
  ): ReplyTemplateRecord | undefined {
    const row = this.database.prepare(`${SELECT_TEMPLATE}
      WHERE rt.id = ? AND o.telegram_user_id = ? AND o.is_active = 1
    `).get(templateId, ownerTelegramId) as unknown as TemplateRow | undefined;
    return row === undefined ? undefined : mapTemplate(row);
  }

  public findByName(
    ownerTelegramId: string,
    accountKey: string,
    name: string,
    excludeId?: number,
  ): ReplyTemplateRecord | undefined {
    const row = this.database.prepare(`${SELECT_TEMPLATE}
      WHERE rt.name = ? COLLATE NOCASE
        AND a.session_key = ?
        AND o.telegram_user_id = ? AND o.is_active = 1
        AND (? IS NULL OR rt.id <> ?)
    `).get(
      name,
      accountKey,
      ownerTelegramId,
      excludeId ?? null,
      excludeId ?? null,
    ) as unknown as TemplateRow | undefined;
    return row === undefined ? undefined : mapTemplate(row);
  }

  public create(
    ownerTelegramId: string,
    accountKey: string,
    name: string,
    body: string,
  ): ReplyTemplateRecord {
    const result = this.database.prepare(`
      INSERT INTO reply_templates (account_id, name, body, is_enabled)
      SELECT a.id, ?, ?, 1
      FROM accounts a JOIN owners o ON o.id = a.owner_id
      WHERE a.session_key = ? AND o.telegram_user_id = ? AND o.is_active = 1
    `).run(name, body, accountKey, ownerTelegramId);
    if (Number(result.changes) === 0) throw new Error('Owner account was not found');
    return this.require(ownerTelegramId, accountKey, Number(result.lastInsertRowid));
  }

  public update(
    ownerTelegramId: string,
    accountKey: string,
    templateId: number,
    name: string,
    body: string,
  ): ReplyTemplateRecord {
    const result = this.database.prepare(`
      UPDATE reply_templates SET name = ?, body = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND account_id = (
        SELECT a.id FROM accounts a JOIN owners o ON o.id = a.owner_id
        WHERE a.session_key = ? AND o.telegram_user_id = ? AND o.is_active = 1
      )
    `).run(name, body, templateId, accountKey, ownerTelegramId);
    assertChanged(result.changes, 'Reply template', templateId);
    return this.require(ownerTelegramId, accountKey, templateId);
  }

  public setEnabled(
    ownerTelegramId: string,
    accountKey: string,
    templateId: number,
    enabled: boolean,
  ): ReplyTemplateRecord {
    const result = this.database.prepare(`
      UPDATE reply_templates SET is_enabled = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND account_id = (
        SELECT a.id FROM accounts a JOIN owners o ON o.id = a.owner_id
        WHERE a.session_key = ? AND o.telegram_user_id = ? AND o.is_active = 1
      )
    `).run(enabled ? 1 : 0, templateId, accountKey, ownerTelegramId);
    assertChanged(result.changes, 'Reply template', templateId);
    return this.require(ownerTelegramId, accountKey, templateId);
  }

  public remove(ownerTelegramId: string, accountKey: string, templateId: number): void {
    const result = this.database.prepare(`
      DELETE FROM reply_templates WHERE id = ? AND account_id = (
        SELECT a.id FROM accounts a JOIN owners o ON o.id = a.owner_id
        WHERE a.session_key = ? AND o.telegram_user_id = ? AND o.is_active = 1
      )
    `).run(templateId, accountKey, ownerTelegramId);
    assertChanged(result.changes, 'Reply template', templateId);
  }

  private require(
    ownerTelegramId: string,
    accountKey: string,
    templateId: number,
  ): ReplyTemplateRecord {
    const template = this.get(ownerTelegramId, accountKey, templateId);
    if (template === undefined) throw new Error(`Reply template not found: ${templateId}`);
    return template;
  }
}

function mapTemplate(row: TemplateRow): ReplyTemplateRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    accountKey: row.session_key,
    accountNickname: row.account_label,
    name: row.name,
    body: row.body,
    enabled: row.is_enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertChanged(changes: number | bigint, label: string, id: number): void {
  if (Number(changes) === 0) throw new Error(`${label} not found: ${id}`);
}
