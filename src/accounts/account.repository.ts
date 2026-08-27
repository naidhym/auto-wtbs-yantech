import type { DatabaseSync } from 'node:sqlite';

import type {
  AccountConnectionStatus,
  AccountRecord,
} from './account.types.js';

interface AccountRow {
  readonly id: number;
  readonly owner_id: number;
  readonly label: string;
  readonly phone_number: string;
  readonly telegram_user_id: string | null;
  readonly session_key: string;
  readonly status: AccountConnectionStatus;
  readonly is_enabled: number;
  readonly last_connected_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const ACCOUNT_COLUMNS = `
  id,
  owner_id,
  label,
  phone_number,
  telegram_user_id,
  session_key,
  status,
  is_enabled,
  last_connected_at,
  created_at,
  updated_at
`;

export class AccountRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(input: {
    readonly ownerTelegramId: string;
    readonly accountKey: string;
    readonly label: string;
    readonly phoneNumber: string;
  }): AccountRecord {
    const owner = this.database
      .prepare('SELECT id FROM owners WHERE telegram_user_id = ? AND is_active = 1')
      .get(input.ownerTelegramId) as { id: number } | undefined;

    if (owner === undefined) {
      throw new Error('Active owner record was not found');
    }

    this.database
      .prepare(
        `
          INSERT INTO accounts (
            owner_id,
            label,
            phone_number,
            session_key,
            status,
            is_enabled
          )
          VALUES (?, ?, ?, ?, 'disconnected', 0)
        `,
      )
      .run(owner.id, input.label, input.phoneNumber, input.accountKey);

    const account = this.getByKey(input.accountKey);

    if (account === undefined) {
      throw new Error('Created account could not be reloaded');
    }

    return account;
  }

  public list(ownerTelegramId: string): AccountRecord[] {
    return this.database
      .prepare(
        `
          SELECT ${ACCOUNT_COLUMNS}
          FROM accounts
          WHERE owner_id = (
            SELECT id FROM owners WHERE telegram_user_id = ? AND is_active = 1
          )
          ORDER BY id
        `,
      )
      .all(ownerTelegramId)
      .map((row) => mapAccountRow(row as unknown as AccountRow));
  }

  public getByKey(accountKey: string): AccountRecord | undefined {
    const row = this.database
      .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE session_key = ?`)
      .get(accountKey) as unknown as AccountRow | undefined;

    return row === undefined ? undefined : mapAccountRow(row);
  }

  public getById(accountId: number): AccountRecord | undefined {
    const row = this.database
      .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`)
      .get(accountId) as unknown as AccountRow | undefined;

    return row === undefined ? undefined : mapAccountRow(row);
  }

  public getByKeyForOwner(
    ownerTelegramId: string,
    accountKey: string,
  ): AccountRecord | undefined {
    const row = this.database
      .prepare(
        `
          SELECT ${ACCOUNT_COLUMNS}
          FROM accounts
          WHERE session_key = ?
            AND owner_id = (
              SELECT id FROM owners WHERE telegram_user_id = ? AND is_active = 1
            )
        `,
      )
      .get(accountKey, ownerTelegramId) as unknown as AccountRow | undefined;

    return row === undefined ? undefined : mapAccountRow(row);
  }

  public getByPhone(
    ownerTelegramId: string,
    phoneNumber: string,
  ): AccountRecord | undefined {
    const row = this.database
      .prepare(
        `
          SELECT ${ACCOUNT_COLUMNS}
          FROM accounts
          WHERE phone_number = ?
            AND owner_id = (
              SELECT id FROM owners WHERE telegram_user_id = ? AND is_active = 1
            )
        `,
      )
      .get(phoneNumber, ownerTelegramId) as unknown as AccountRow | undefined;

    return row === undefined ? undefined : mapAccountRow(row);
  }

  public getByNickname(
    ownerTelegramId: string,
    nickname: string,
    excludeAccountKey?: string,
  ): AccountRecord | undefined {
    const row = this.database
      .prepare(
        `
          SELECT ${ACCOUNT_COLUMNS}
          FROM accounts
          WHERE label = ? COLLATE NOCASE
            AND owner_id = (
              SELECT id FROM owners WHERE telegram_user_id = ? AND is_active = 1
            )
            AND (? IS NULL OR session_key <> ?)
        `,
      )
      .get(
        nickname,
        ownerTelegramId,
        excludeAccountKey ?? null,
        excludeAccountKey ?? null,
      ) as unknown as AccountRow | undefined;

    return row === undefined ? undefined : mapAccountRow(row);
  }

  public rename(
    ownerTelegramId: string,
    accountKey: string,
    nickname: string,
  ): AccountRecord {
    const result = this.database
      .prepare(
        `
          UPDATE accounts
          SET
            label = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE session_key = ?
            AND owner_id = (
              SELECT id FROM owners WHERE telegram_user_id = ? AND is_active = 1
            )
        `,
      )
      .run(nickname, accountKey, ownerTelegramId);

    this.assertUpdated(result.changes, accountKey);
    const account = this.getByKeyForOwner(ownerTelegramId, accountKey);

    if (account === undefined) {
      throw new Error(`Account not found after rename: ${accountKey}`);
    }

    return account;
  }

  public updateEnabled(accountKey: string, enabled: boolean): AccountRecord {
    const status: AccountConnectionStatus = enabled ? 'disconnected' : 'disabled';
    const result = this.database
      .prepare(
        `
          UPDATE accounts
          SET
            is_enabled = ?,
            status = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE session_key = ?
        `,
      )
      .run(enabled ? 1 : 0, status, accountKey);

    this.assertUpdated(result.changes, accountKey);
    return this.requireByKey(accountKey);
  }

  public updateStatus(
    accountKey: string,
    status: AccountConnectionStatus,
  ): AccountRecord {
    const result = this.database
      .prepare(
        `
          UPDATE accounts
          SET
            status = ?,
            last_connected_at = CASE
              WHEN ? = 'connected' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              ELSE last_connected_at
            END,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE session_key = ?
        `,
      )
      .run(status, status, accountKey);

    this.assertUpdated(result.changes, accountKey);
    return this.requireByKey(accountKey);
  }

  public recordLoginSuccess(
    accountKey: string,
    telegramUserId: string | undefined,
  ): AccountRecord {
    const result = this.database
      .prepare(
        `
          UPDATE accounts
          SET
            telegram_user_id = COALESCE(?, telegram_user_id),
            is_enabled = 1,
            status = 'connected',
            last_connected_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE session_key = ?
        `,
      )
      .run(telegramUserId ?? null, accountKey);

    this.assertUpdated(result.changes, accountKey);
    return this.requireByKey(accountKey);
  }

  public remove(accountKey: string): void {
    const result = this.database
      .prepare('DELETE FROM accounts WHERE session_key = ?')
      .run(accountKey);

    this.assertUpdated(result.changes, accountKey);
  }

  private requireByKey(accountKey: string): AccountRecord {
    const account = this.getByKey(accountKey);

    if (account === undefined) {
      throw new Error(`Account not found: ${accountKey}`);
    }

    return account;
  }

  private assertUpdated(changes: number | bigint, accountKey: string): void {
    if (Number(changes) === 0) {
      throw new Error(`Account not found: ${accountKey}`);
    }
  }
}

function mapAccountRow(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    accountKey: row.session_key,
    nickname: row.label,
    label: row.label,
    phoneNumber: row.phone_number,
    ...(row.telegram_user_id === null
      ? {}
      : { telegramUserId: row.telegram_user_id }),
    status: row.status,
    enabled: row.is_enabled === 1,
    ...(row.last_connected_at === null
      ? {}
      : { lastConnectedAt: row.last_connected_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
