import type { DatabaseSync } from 'node:sqlite';

import type {
  ChannelAssignmentRecord,
  ChannelOperationalStatus,
  ChannelRecord,
  ResolvedTelegramChannel,
} from './channel.types.js';

interface ChannelRow {
  id: number;
  telegram_channel_id: string;
  username: string | null;
  title: string;
  is_enabled: number;
  status: ChannelOperationalStatus;
  automation_blocked: number;
  blocked_reason: string | null;
  blocked_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AssignmentRow {
  id: number;
  account_id: number;
  session_key: string;
  label: string;
  channel_id: number;
  is_enabled: number;
  status: ChannelOperationalStatus;
  created_at: string;
  updated_at: string;
}

const CHANNEL_COLUMNS = `
  id, telegram_channel_id, username, title, is_enabled, status,
  automation_blocked, blocked_reason, blocked_at, created_at, updated_at
`;

const ASSIGNMENT_COLUMNS = `
  ac.id, ac.account_id, a.session_key, a.label, ac.channel_id,
  ac.is_enabled, ac.status, ac.created_at, ac.updated_at
`;

export class ChannelRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public list(ownerTelegramId: string): ChannelRecord[] {
    return this.database.prepare(`
      SELECT DISTINCT ${CHANNEL_COLUMNS.split(',').map((column) => `c.${column.trim()}`).join(', ')}
      FROM channels c
      JOIN account_channels ac ON ac.channel_id = c.id
      JOIN accounts a ON a.id = ac.account_id
      JOIN owners o ON o.id = a.owner_id
      WHERE o.telegram_user_id = ? AND o.is_active = 1
      ORDER BY c.title COLLATE NOCASE, c.id
    `).all(ownerTelegramId).map((row) => mapChannel(row as unknown as ChannelRow));
  }

  public getForOwner(ownerTelegramId: string, channelId: number): ChannelRecord | undefined {
    const row = this.database.prepare(`
      SELECT ${CHANNEL_COLUMNS.split(',').map((column) => `c.${column.trim()}`).join(', ')}
      FROM channels c
      WHERE c.id = ? AND EXISTS (
        SELECT 1 FROM account_channels ac
        JOIN accounts a ON a.id = ac.account_id
        JOIN owners o ON o.id = a.owner_id
        WHERE ac.channel_id = c.id AND o.telegram_user_id = ? AND o.is_active = 1
      )
    `).get(channelId, ownerTelegramId) as unknown as ChannelRow | undefined;
    return row === undefined ? undefined : mapChannel(row);
  }

  public getByTelegramId(telegramChannelId: string): ChannelRecord | undefined {
    const row = this.database.prepare(`SELECT ${CHANNEL_COLUMNS} FROM channels WHERE telegram_channel_id = ?`)
      .get(telegramChannelId) as unknown as ChannelRow | undefined;
    return row === undefined ? undefined : mapChannel(row);
  }

  public saveResolved(channel: ResolvedTelegramChannel): ChannelRecord {
    this.database.prepare(`
      INSERT INTO channels (telegram_channel_id, username, title, is_enabled, status)
      VALUES (?, ?, ?, 1, 'pending')
      ON CONFLICT(telegram_channel_id) DO UPDATE SET
        username = excluded.username,
        title = excluded.title,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `).run(channel.telegramChannelId, channel.username ?? null, channel.title);
    return this.requireByTelegramId(channel.telegramChannelId);
  }

  public saveBulkResolved(channels: readonly ResolvedTelegramChannel[]): ChannelRecord[] {
    const stmt = this.database.prepare(`
      INSERT INTO channels (telegram_channel_id, username, title, is_enabled, status)
      VALUES (?, ?, ?, 1, 'pending')
      ON CONFLICT(telegram_channel_id) DO UPDATE SET
        username = excluded.username,
        title = excluded.title,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `);
    for (const channel of channels) {
      stmt.run(channel.telegramChannelId, channel.username ?? null, channel.title);
    }
    return channels.map((c) => this.requireByTelegramId(c.telegramChannelId));
  }

  public assignBulk(accountId: number, channelIds: readonly number[]): ChannelAssignmentRecord[] {
    const stmt = this.database.prepare(`
      INSERT INTO account_channels (account_id, channel_id, is_enabled, status)
      VALUES (?, ?, 1, 'pending')
    `);
    const assignments: ChannelAssignmentRecord[] = [];
    for (const channelId of channelIds) {
      stmt.run(accountId, channelId);
      assignments.push(this.requireAssignment(accountId, channelId));
    }
    return assignments;
  }

  public removeBulk(channelIds: readonly number[]): void {
    const stmt = this.database.prepare('DELETE FROM channels WHERE id = ?');
    for (const channelId of channelIds) {
      stmt.run(channelId);
    }
  }

  public unassignBulk(assignmentIds: readonly number[]): void {
    const stmt = this.database.prepare('DELETE FROM account_channels WHERE id = ?');
    for (const assignmentId of assignmentIds) {
      stmt.run(assignmentId);
    }
  }

  public setStatusBulk(channelIds: readonly number[], status: ChannelOperationalStatus): void {
    const stmt = this.database.prepare(`
      UPDATE channels SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
    `);
    for (const channelId of channelIds) {
      stmt.run(status, channelId);
    }
  }

  public setAssignmentStatusBulk(assignmentIds: readonly number[], status: ChannelOperationalStatus): void {
    const stmt = this.database.prepare(`
      UPDATE account_channels SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
    `);
    for (const assignmentId of assignmentIds) {
      stmt.run(status, assignmentId);
    }
  }

  public setChannelEnabled(channelId: number, enabled: boolean): void {
    const result = this.database.prepare(`
      UPDATE channels SET is_enabled = ?, status = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
    `).run(enabled ? 1 : 0, enabled ? 'healthy' : 'disabled', channelId);
    assertChanged(result.changes, 'Channel', channelId);
  }

  public remove(channelId: number): void {
    const result = this.database.prepare('DELETE FROM channels WHERE id = ?').run(channelId);
    assertChanged(result.changes, 'Channel', channelId);
  }

  public assign(accountId: number, channelId: number): ChannelAssignmentRecord {
    this.database.prepare(`
      INSERT INTO account_channels (account_id, channel_id, is_enabled, status)
      VALUES (?, ?, 1, 'healthy')
    `).run(accountId, channelId);
    return this.requireAssignment(accountId, channelId);
  }

  public getAssignment(accountId: number, channelId: number): ChannelAssignmentRecord | undefined {
    const row = this.database.prepare(`
      SELECT ${ASSIGNMENT_COLUMNS}
      FROM account_channels ac JOIN accounts a ON a.id = ac.account_id
      WHERE ac.account_id = ? AND ac.channel_id = ?
    `).get(accountId, channelId) as unknown as AssignmentRow | undefined;
    return row === undefined ? undefined : mapAssignment(row);
  }

  public getAssignmentById(ownerTelegramId: string, assignmentId: number): ChannelAssignmentRecord | undefined {
    const row = this.database.prepare(`
      SELECT ${ASSIGNMENT_COLUMNS}
      FROM account_channels ac
      JOIN accounts a ON a.id = ac.account_id
      JOIN owners o ON o.id = a.owner_id
      WHERE ac.id = ? AND o.telegram_user_id = ? AND o.is_active = 1
    `).get(assignmentId, ownerTelegramId) as unknown as AssignmentRow | undefined;
    return row === undefined ? undefined : mapAssignment(row);
  }

  public listAssignmentsForChannel(ownerTelegramId: string, channelId: number): ChannelAssignmentRecord[] {
    return this.database.prepare(`
      SELECT ${ASSIGNMENT_COLUMNS}
      FROM account_channels ac
      JOIN accounts a ON a.id = ac.account_id
      JOIN owners o ON o.id = a.owner_id
      WHERE ac.channel_id = ? AND o.telegram_user_id = ? AND o.is_active = 1
      ORDER BY a.label COLLATE NOCASE, a.id
    `).all(channelId, ownerTelegramId).map((row) => mapAssignment(row as unknown as AssignmentRow));
  }

  public listAssignmentsForAccount(ownerTelegramId: string, accountKey: string): Array<{ channel: ChannelRecord; assignment: ChannelAssignmentRecord }> {
    const assignments = this.database.prepare(`
      SELECT ${ASSIGNMENT_COLUMNS}
      FROM account_channels ac
      JOIN accounts a ON a.id = ac.account_id
      JOIN owners o ON o.id = a.owner_id
      WHERE a.session_key = ? AND o.telegram_user_id = ? AND o.is_active = 1
      ORDER BY ac.id
    `).all(accountKey, ownerTelegramId).map((row) => mapAssignment(row as unknown as AssignmentRow));
    return assignments.map((assignment) => ({
      assignment,
      channel: this.requireChannel(assignment.channelId),
    }));
  }

  public listEffectiveAssignments(
    ownerTelegramId: string,
  ): Array<{ channel: ChannelRecord; assignment: ChannelAssignmentRecord }> {
    const rows = this.database.prepare(`
      SELECT ${ASSIGNMENT_COLUMNS}
      FROM account_channels ac
      JOIN accounts a ON a.id = ac.account_id
      JOIN owners o ON o.id = a.owner_id
      JOIN channels c ON c.id = ac.channel_id
      WHERE ac.is_enabled = 1 AND c.is_enabled = 1 AND c.automation_blocked = 0
        AND a.is_enabled = 1 AND o.telegram_user_id = ? AND o.is_active = 1
      ORDER BY ac.id, a.id
    `).all(ownerTelegramId).map((row) => mapAssignment(row as unknown as AssignmentRow));
    return rows.map((assignment) => ({ assignment, channel: this.requireChannel(assignment.channelId) }));
  }

  /** Includes ineligible rows so production diagnostics can show the first eligibility boundary. */
  public listListenerAssignmentAudit(ownerTelegramId: string): Array<{
    readonly channel: ChannelRecord;
    readonly assignment: ChannelAssignmentRecord;
    readonly accountEnabled: boolean;
    readonly accountStatus: string;
  }> {
    const rows = this.database.prepare(`
      SELECT ${ASSIGNMENT_COLUMNS}, a.is_enabled AS account_is_enabled, a.status AS account_status
      FROM account_channels ac
      JOIN accounts a ON a.id = ac.account_id
      JOIN owners o ON o.id = a.owner_id
      WHERE o.telegram_user_id = ? AND o.is_active = 1
      ORDER BY ac.id, a.id
    `).all(ownerTelegramId) as unknown as Array<AssignmentRow & {
      account_is_enabled: number;
      account_status: string;
    }>;
    return rows.map((row) => {
      const assignment = mapAssignment(row);
      return {
        assignment,
        channel: this.requireChannel(assignment.channelId),
        accountEnabled: row.account_is_enabled === 1,
        accountStatus: row.account_status,
      };
    });
  }

  public listEffectiveAssignmentsForChannel(
    ownerTelegramId: string,
    channelId: number,
  ): Array<{ channel: ChannelRecord; assignment: ChannelAssignmentRecord }> {
    const assignments = this.database.prepare(`
      SELECT ${ASSIGNMENT_COLUMNS}
      FROM account_channels ac
      JOIN accounts a ON a.id = ac.account_id
      JOIN owners o ON o.id = a.owner_id
      JOIN channels c ON c.id = ac.channel_id
      WHERE ac.channel_id = ?
        AND o.telegram_user_id = ? AND o.is_active = 1
        AND ac.is_enabled = 1 AND c.is_enabled = 1
        AND c.automation_blocked = 0 AND a.is_enabled = 1
      ORDER BY ac.id, a.id
    `).all(channelId, ownerTelegramId)
      .map((row) => mapAssignment(row as unknown as AssignmentRow));
    return assignments.map((assignment) => ({
      assignment,
      channel: this.requireChannel(assignment.channelId),
    }));
  }

  public setAutomationBlocked(
    channelId: number,
    blocked: boolean,
    reason?: string,
  ): ChannelRecord {
    const result = this.database.prepare(`
      UPDATE channels SET
        automation_blocked = ?,
        blocked_reason = ?,
        blocked_at = CASE
          WHEN ? = 1 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          ELSE NULL
        END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(blocked ? 1 : 0, blocked ? reason ?? 'manual_block' : null, blocked ? 1 : 0, channelId);
    assertChanged(result.changes, 'Channel', channelId);
    return this.requireChannel(channelId);
  }

  public setAssignmentEnabled(assignmentId: number, enabled: boolean): void {
    const result = this.database.prepare(`
      UPDATE account_channels SET is_enabled = ?, status = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
    `).run(enabled ? 1 : 0, enabled ? 'healthy' : 'disabled', assignmentId);
    assertChanged(result.changes, 'Channel assignment', assignmentId);
  }

  public setAssignmentStatus(assignmentId: number, status: ChannelOperationalStatus): void {
    this.database.prepare(`
      UPDATE account_channels SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
    `).run(status, assignmentId);
  }

  public unassign(assignmentId: number): void {
    const result = this.database.prepare('DELETE FROM account_channels WHERE id = ?').run(assignmentId);
    assertChanged(result.changes, 'Channel assignment', assignmentId);
  }

  private requireByTelegramId(telegramChannelId: string): ChannelRecord {
    const channel = this.getByTelegramId(telegramChannelId);
    if (channel === undefined) throw new Error('Saved channel could not be reloaded');
    return channel;
  }

  private requireChannel(channelId: number): ChannelRecord {
    const row = this.database.prepare(`SELECT ${CHANNEL_COLUMNS} FROM channels WHERE id = ?`).get(channelId) as unknown as ChannelRow | undefined;
    if (row === undefined) throw new Error(`Channel not found: ${channelId}`);
    return mapChannel(row);
  }

  private requireAssignment(accountId: number, channelId: number): ChannelAssignmentRecord {
    const assignment = this.getAssignment(accountId, channelId);
    if (assignment === undefined) throw new Error('Saved channel assignment could not be reloaded');
    return assignment;
  }
}

function mapChannel(row: ChannelRow): ChannelRecord {
  return {
    id: row.id,
    telegramChannelId: row.telegram_channel_id,
    ...(row.username === null ? {} : { username: row.username }),
    title: row.title,
    enabled: row.is_enabled === 1,
    status: row.status,
    automationBlocked: row.automation_blocked === 1,
    ...(row.blocked_reason === null ? {} : { blockedReason: row.blocked_reason }),
    ...(row.blocked_at === null ? {} : { blockedAt: row.blocked_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAssignment(row: AssignmentRow): ChannelAssignmentRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    accountKey: row.session_key,
    accountNickname: row.label,
    channelId: row.channel_id,
    enabled: row.is_enabled === 1,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertChanged(changes: number | bigint, label: string, id: number): void {
  if (Number(changes) === 0) throw new Error(`${label} not found: ${id}`);
}
