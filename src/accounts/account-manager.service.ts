import { errorReason, type AppLogger } from '../logging/logger.js';
import {
  type GramJsClientService,
  type TelegramClientFactory,
  type TelegramClientStatus,
} from '../user-client/gramjs-client.service.js';
import { TelegramClientRegistry } from '../user-client/telegram-client.registry.js';
import { TelegramChannelSyncStateRepository } from '../user-client/telegram-channel-sync-state.repository.js';
import { AccountService } from './account.service.js';
import type { AccountRecord, CreateAccountInput } from './account.types.js';
import { AccountSessionStore } from './session-store.js';

export type LoginState =
  | 'starting'
  | 'awaiting_otp'
  | 'verifying_otp'
  | 'awaiting_password'
  | 'verifying_password'
  | 'authenticated'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export interface LoginStatus {
  readonly accountKey: string;
  readonly state: LoginState;
  readonly expiresAt?: string;
  readonly errorReason?: string;
}

export interface AccountManagerOptions {
  readonly apiId?: number;
  readonly apiHash?: string;
  readonly loginTimeoutMs: number;
  readonly clientFactory?: TelegramClientFactory;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

interface LoginAttempt {
  readonly account: AccountRecord;
  readonly expiresAt: string;
  readonly cancellation: Deferred<never>;
  signal: Deferred<LoginStatus>;
  state: LoginState;
  otp?: Deferred<string>;
  password?: Deferred<string>;
  cancelReason?: 'cancelled' | 'timed_out';
  lastAuthError?: string;
  timer: NodeJS.Timeout;
}

class LoginCancelledError extends Error {
  public constructor(public readonly reason: 'cancelled' | 'timed_out') {
    super(reason === 'timed_out' ? 'Login timed out' : 'Login cancelled');
    this.name = 'LoginCancelledError';
  }
}

export class AccountManagerService {
  private readonly attempts = new Map<string, LoginAttempt>();
  private readonly lastLoginStatuses = new Map<string, LoginStatus>();

  public constructor(
    private readonly accounts: AccountService,
    private readonly sessions: AccountSessionStore,
    private readonly clients: TelegramClientRegistry,
    private readonly logger: AppLogger,
    private readonly options: AccountManagerOptions,
    private readonly syncStates: TelegramChannelSyncStateRepository,
  ) {}

  public addAccount(input: CreateAccountInput): AccountRecord {
    return this.accounts.add(input);
  }

  public listAccounts(): AccountRecord[] {
    return this.accounts.list();
  }

  public getAccount(accountKey: string): AccountRecord {
    return this.accounts.get(accountKey);
  }

  public validateNickname(nickname: string, excludeAccountKey?: string): string {
    return this.accounts.validateNickname(nickname, excludeAccountKey);
  }

  public rename(accountKey: string, nickname: string): AccountRecord {
    return this.accounts.rename(accountKey, nickname);
  }

  public getLoginStatus(accountKey: string): LoginStatus | undefined {
    const attempt = this.attempts.get(accountKey);
    return attempt === undefined
      ? this.lastLoginStatuses.get(accountKey)
      : this.toLoginStatus(attempt);
  }

  public async startLogin(accountKey: string): Promise<LoginStatus> {
    const account = this.accounts.get(accountKey);
    this.requireTelegramCredentials();

    if (this.attempts.has(accountKey)) {
      throw new Error(`Login is already active for ${accountKey}`);
    }

    this.lastLoginStatuses.delete(accountKey);

    if (this.clients.has(accountKey)) {
      await this.clients.unregister(accountKey);
    }

    const expiresAt = new Date(Date.now() + this.options.loginTimeoutMs).toISOString();
    const attempt: LoginAttempt = {
      account,
      expiresAt,
      cancellation: deferred<never>(),
      signal: deferred<LoginStatus>(),
      state: 'starting',
      timer: setTimeout(() => {
        void this.cancelLogin(accountKey, 'timed_out').catch(() => undefined);
      }, this.options.loginTimeoutMs),
    };
    attempt.timer.unref();
    this.attempts.set(accountKey, attempt);
    this.accounts.updateStatus(accountKey, 'connecting');
    this.logger.info(
      { account: accountKey, action: 'login_started', status: 'started' },
      'Telegram account login started',
    );

    const firstSignal = attempt.signal.promise;
    void this.runLogin(attempt);
    return firstSignal;
  }

  public submitOtp(accountKey: string, otp: string): Promise<LoginStatus> {
    const attempt = this.requireAttempt(accountKey);
    const code = otp.trim();

    if (attempt.state !== 'awaiting_otp' || attempt.otp === undefined) {
      throw new Error(`Account ${accountKey} is not waiting for an OTP`);
    }

    if (!/^\d{3,10}$/.test(code)) {
      throw new Error('OTP must contain 3-10 digits');
    }

    const nextSignal = attempt.signal.promise;
    const waiter = attempt.otp;
    delete attempt.otp;
    attempt.state = 'verifying_otp';
    waiter.resolve(code);
    return nextSignal;
  }

  public submitPassword(accountKey: string, password: string): Promise<LoginStatus> {
    const attempt = this.requireAttempt(accountKey);

    if (attempt.state !== 'awaiting_password' || attempt.password === undefined) {
      throw new Error(`Account ${accountKey} is not waiting for a 2FA password`);
    }

    if (password.length === 0) {
      throw new Error('2FA password cannot be empty');
    }

    const nextSignal = attempt.signal.promise;
    const waiter = attempt.password;
    delete attempt.password;
    attempt.state = 'verifying_password';
    waiter.resolve(password);
    return nextSignal;
  }

  public async cancelLogin(
    accountKey: string,
    reason: 'cancelled' | 'timed_out' = 'cancelled',
  ): Promise<LoginStatus> {
    const attempt = this.requireAttempt(accountKey);
    const nextSignal = attempt.signal.promise;
    const cancellation = new LoginCancelledError(reason);
    attempt.cancelReason = reason;
    attempt.otp?.reject(cancellation);
    attempt.password?.reject(cancellation);
    attempt.cancellation.reject(cancellation);
    await this.clients.get(accountKey)?.abort().catch(() => undefined);
    return nextSignal;
  }

  public async restoreEnabledAccounts(): Promise<void> {
    const enabledAccounts = this.accounts.list().filter((account) => account.enabled);
    const results = await Promise.allSettled(
      enabledAccounts.map(async (account) => this.restoreAccount(account.accountKey)),
    );
    const failed = results.filter((result) => result.status === 'rejected').length;
    this.logger[failed === 0 ? 'info' : 'warn'](
      {
        action: 'account_restore_summary',
        status: failed === 0 ? 'ready' : 'partial_failure',
        eligible: enabledAccounts.length,
        restored: enabledAccounts.length - failed,
        failed,
      },
      'Enabled Telegram account restoration completed',
    );
  }

  public async restoreAccount(accountKey: string): Promise<TelegramClientStatus> {
    const account = this.accounts.get(accountKey);
    let storedSession: string;

    try {
      const session = this.sessions.read(accountKey);

      if (session === undefined) {
        throw new Error('No persistent session exists for this account');
      }

      storedSession = session;
    } catch (error) {
      this.accounts.updateStatus(accountKey, 'error');
      this.sessions.remove(accountKey);
      this.logSessionInvalid(accountKey, error);
      throw error;
    }

    if (this.clients.has(accountKey)) {
      await this.clients.unregister(accountKey);
    }

    const client = this.registerClient(account, storedSession);

    try {
      await client.connect();

      if (!(await client.isAuthorized())) {
        throw new Error('Stored Telegram session is no longer authorized');
      }

      this.accounts.updateStatus(accountKey, 'connected');
      this.logger.info(
        { account: accountKey, action: 'session_restored', status: 'restored' },
        'Telegram session restored',
      );
      this.logger.info(
        { account: accountKey, action: 'connected', status: 'connected' },
        'Telegram account connected',
      );
      return client.getStatus();
    } catch (error) {
      await client.abort().catch(() => undefined);
      await this.clients.unregister(accountKey, false);
      this.accounts.updateStatus(accountKey, 'error');

      if (isAuthorizationFailure(error)) {
        this.sessions.remove(accountKey);
        this.logSessionInvalid(accountKey, error);
      } else {
        this.logger.error(
          {
            account: accountKey,
            action: 'reconnect_failed',
            status: 'failed',
            errorReason: safeErrorReason(error),
          },
          'Telegram session restore failed',
        );
      }

      throw error;
    }
  }

  public async reconnect(accountKey: string): Promise<TelegramClientStatus> {
    const account = this.accounts.get(accountKey);

    if (!account.enabled) {
      throw new Error(`Account ${accountKey} is disabled`);
    }

    this.logger.info(
      { account: accountKey, action: 'reconnect_started', status: 'started' },
      'Telegram account reconnect started',
    );

    try {
      const existing = this.clients.get(accountKey);
      const status = existing === undefined
        ? await this.restoreAccount(accountKey)
        : await existing.reconnect();
      this.accounts.updateStatus(accountKey, 'connected');
      this.logger.info(
        { account: accountKey, action: 'reconnect_success', status: 'connected' },
        'Telegram account reconnected',
      );
      return status;
    } catch (error) {
      this.accounts.updateStatus(accountKey, 'error');
      this.logger.error(
        {
          account: accountKey,
          action: 'reconnect_failed',
          status: 'failed',
          errorReason: safeErrorReason(error),
        },
        'Telegram account reconnect failed',
      );
      throw error;
    }
  }

  public async disconnect(accountKey: string): Promise<void> {
    this.accounts.get(accountKey);
    await this.clients.unregister(accountKey);

    this.accounts.updateStatus(accountKey, 'disconnected');
    this.logger.info(
      { account: accountKey, action: 'disconnected', status: 'disconnected' },
      'Telegram account disconnected',
    );
  }

  public async enable(accountKey: string): Promise<AccountRecord> {
    this.accounts.setEnabled(accountKey, true);

    if (this.sessions.has(accountKey)) {
      await this.restoreAccount(accountKey);
    }

    return this.accounts.get(accountKey);
  }

  public async disable(accountKey: string): Promise<AccountRecord> {
    if (this.attempts.has(accountKey)) {
      await this.cancelLogin(accountKey).catch(() => undefined);
    }

    const client = this.clients.get(accountKey);
    await client?.abort().catch(() => undefined);
    await this.clients.unregister(accountKey, false);
    const account = this.accounts.setEnabled(accountKey, false);
    this.logger.info(
      { account: accountKey, action: 'account_disabled', status: 'disabled' },
      'Telegram account disabled',
    );
    return account;
  }

  public async remove(accountKey: string): Promise<void> {
    if (this.attempts.has(accountKey)) {
      await this.cancelLogin(accountKey).catch(() => undefined);
    }

    const client = this.clients.get(accountKey);
    await client?.abort();
    await this.clients.unregister(accountKey, false);
    this.sessions.remove(accountKey);
    this.accounts.remove(accountKey);
  }

  public async shutdown(): Promise<void> {
    await Promise.allSettled(
      [...this.attempts.keys()].map(async (accountKey) => this.cancelLogin(accountKey)),
    );
    await this.clients.disconnectAll();
  }

  private async runLogin(attempt: LoginAttempt): Promise<void> {
    const { account } = attempt;
    let client: GramJsClientService | undefined;
    let authPromise: Promise<TelegramClientStatus> | undefined;
    let sessionPersisted = false;

    try {
      client = this.registerClient(account, '');
      authPromise = client.authenticate({
        phoneNumber: account.phoneNumber,
        phoneCode: async () => {
          attempt.otp = deferred<string>();
          attempt.state = 'awaiting_otp';
          this.logger.info(
            { account: account.accountKey, action: 'otp_requested', status: 'waiting' },
            'Telegram OTP requested',
          );
          this.publish(attempt);
          return attempt.otp.promise;
        },
        password: async () => {
          attempt.password = deferred<string>();
          attempt.state = 'awaiting_password';
          this.publish(attempt);
          return attempt.password.promise;
        },
        onError: (error) => {
          attempt.lastAuthError = safeErrorReason(error);
        },
      });
      await Promise.race([authPromise, attempt.cancellation.promise]);
      const session = client.exportSession();

      if (session.length === 0) {
        throw new Error('Telegram returned an empty authorized session');
      }

      this.sessions.write(account.accountKey, session);
      sessionPersisted = true;
      const telegramUserId = await client.getTelegramUserId();
      this.accounts.recordLoginSuccess(account.accountKey, telegramUserId);
      attempt.state = 'authenticated';
      this.logger.info(
        { account: account.accountKey, action: 'login_success', status: 'connected' },
        'Telegram account login succeeded',
      );
      this.logger.info(
        { account: account.accountKey, action: 'connected', status: 'connected' },
        'Telegram account connected',
      );
      this.publish(attempt);
    } catch (error) {
      void authPromise?.catch(() => undefined);
      await client?.abort().catch(() => undefined);
      await this.clients.unregister(account.accountKey, false);
      if (sessionPersisted) {
        this.sessions.remove(account.accountKey);
      }
      const cancellationReason = attempt.cancelReason;
      attempt.state = cancellationReason ?? 'failed';
      this.accounts.updateStatus(
        account.accountKey,
        cancellationReason === undefined ? 'error' : 'disconnected',
      );
      this.logger.warn(
        {
          account: account.accountKey,
          action: 'login_failed',
          status: attempt.state,
          errorReason:
            cancellationReason ?? attempt.lastAuthError ?? safeErrorReason(error),
        },
        'Telegram account login did not complete',
      );
      this.publish(attempt);
    } finally {
      clearTimeout(attempt.timer);
      this.attempts.delete(account.accountKey);
    }
  }

  private registerClient(account: AccountRecord, session: string) {
    const { apiId, apiHash } = this.requireTelegramCredentials();
    return this.clients.register(
      {
        accountKey: account.accountKey,
        apiId,
        apiHash,
        session,
        syncStateRepository: this.syncStates,
      },
      this.options.clientFactory,
    );
  }

  private requireTelegramCredentials(): { apiId: number; apiHash: string } {
    if (this.options.apiId === undefined || this.options.apiHash === undefined) {
      throw new Error('Telegram API credentials are not configured');
    }

    return { apiId: this.options.apiId, apiHash: this.options.apiHash };
  }

  private requireAttempt(accountKey: string): LoginAttempt {
    const attempt = this.attempts.get(accountKey);

    if (attempt === undefined) {
      throw new Error(`No active login for ${accountKey}`);
    }

    return attempt;
  }

  private publish(attempt: LoginAttempt): void {
    const signal = attempt.signal;
    attempt.signal = deferred<LoginStatus>();
    const status = this.toLoginStatus(attempt);
    this.lastLoginStatuses.set(attempt.account.accountKey, status);
    signal.resolve(status);
  }

  private toLoginStatus(attempt: LoginAttempt): LoginStatus {
    return {
      accountKey: attempt.account.accountKey,
      state: attempt.state,
      expiresAt: attempt.expiresAt,
      ...(attempt.lastAuthError === undefined
        ? {}
        : { errorReason: attempt.lastAuthError }),
    };
  }

  private logSessionInvalid(accountKey: string, error: unknown): void {
    this.logger.warn(
      {
        account: accountKey,
        action: 'session_invalid',
        status: 'invalid',
        errorReason: safeErrorReason(error),
      },
      'Telegram session is invalid',
    );
  }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function safeErrorReason(error: unknown): string {
  if (error instanceof LoginCancelledError) {
    return error.reason;
  }

  if (error instanceof Error) {
    return error.name || 'telegram_error';
  }

  return errorReason(error) === 'Unknown error' ? 'unknown_error' : 'telegram_error';
}

function isAuthorizationFailure(error: unknown): boolean {
  return error instanceof Error && (
    error.message.includes('no longer authorized') ||
    error.message.includes('empty')
  );
}
