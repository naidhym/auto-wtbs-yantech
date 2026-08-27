import { randomUUID } from 'node:crypto';

import { errorReason, type AppLogger } from '../logging/logger.js';
import { AccountRepository } from './account.repository.js';
import type {
  AccountConnectionStatus,
  AccountRecord,
  CreateAccountInput,
} from './account.types.js';

const PHONE_PATTERN = /^\+[1-9]\d{6,14}$/;
const ACCOUNT_KEY_PATTERN = /^account-[a-f0-9-]{36}$/;

export type AccountKeyFactory = () => string;

export class AccountService {
  public constructor(
    private readonly repository: AccountRepository,
    private readonly ownerTelegramId: string,
    private readonly logger: AppLogger,
    private readonly keyFactory: AccountKeyFactory = () => `account-${randomUUID()}`,
  ) {}

  public add(input: CreateAccountInput): AccountRecord {
    const label = this.validateNickname(input.label);
    const phoneNumber = input.phoneNumber.trim();

    if (!PHONE_PATTERN.test(phoneNumber)) {
      throw new Error('Phone number must use international format, for example +628123456789');
    }

    if (this.repository.getByPhone(this.ownerTelegramId, phoneNumber) !== undefined) {
      throw new Error('An account with this phone number already exists');
    }

    const accountKey = this.keyFactory();

    if (!ACCOUNT_KEY_PATTERN.test(accountKey)) {
      throw new Error('Generated account key is not safe for isolated storage');
    }

    try {
      const account = this.repository.create({
        ownerTelegramId: this.ownerTelegramId,
        accountKey,
        label,
        phoneNumber,
      });
      this.logger.info(
        { account: account.accountKey, action: 'account_created', status: 'created' },
        'Telegram account record created',
      );
      return account;
    } catch (error) {
      this.logger.error(
        {
          account: accountKey,
          action: 'account_created',
          status: 'failed',
          errorReason: errorReason(error),
        },
        'Telegram account record creation failed',
      );
      throw error;
    }
  }

  public list(): AccountRecord[] {
    return this.repository.list(this.ownerTelegramId);
  }

  public validateNickname(
    nickname: string,
    excludeAccountKey?: string,
  ): string {
    const normalized = nickname.trim().replace(/\s+/g, ' ');

    if (normalized.length < 1 || normalized.length > 64) {
      throw new Error('Account nickname must contain 1-64 characters');
    }

    if (
      this.repository.getByNickname(
        this.ownerTelegramId,
        normalized,
        excludeAccountKey,
      ) !== undefined
    ) {
      throw new Error('An account with this nickname already exists');
    }

    return normalized;
  }

  public rename(accountKey: string, nickname: string): AccountRecord {
    this.get(accountKey);
    const normalized = this.validateNickname(nickname, accountKey);
    const account = this.repository.rename(
      this.ownerTelegramId,
      accountKey,
      normalized,
    );
    this.logger.info(
      { account: accountKey, action: 'account_renamed', status: 'updated' },
      'Telegram account nickname updated',
    );
    return account;
  }

  public get(accountKey: string): AccountRecord {
    const account = this.repository.getByKeyForOwner(
      this.ownerTelegramId,
      accountKey,
    );

    if (account === undefined) {
      throw new Error(`Account not found: ${accountKey}`);
    }

    return account;
  }

  public getById(accountId: number): AccountRecord | undefined {
    return this.repository.getById(accountId);
  }

  public setEnabled(accountKey: string, enabled: boolean): AccountRecord {
    this.get(accountKey);
    return this.repository.updateEnabled(accountKey, enabled);
  }

  public updateStatus(
    accountKey: string,
    status: AccountConnectionStatus,
  ): AccountRecord {
    this.get(accountKey);
    return this.repository.updateStatus(accountKey, status);
  }

  public recordLoginSuccess(
    accountKey: string,
    telegramUserId: string | undefined,
  ): AccountRecord {
    this.get(accountKey);
    return this.repository.recordLoginSuccess(accountKey, telegramUserId);
  }

  public remove(accountKey: string): void {
    this.get(accountKey);
    this.repository.remove(accountKey);
    this.logger.info(
      { account: accountKey, action: 'account_removed', status: 'removed' },
      'Telegram account removed',
    );
  }
}
