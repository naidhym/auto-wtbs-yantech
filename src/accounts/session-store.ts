import fs from 'node:fs';
import path from 'node:path';

const ACCOUNT_KEY_PATTERN = /^account-[a-f0-9-]{36}$/;
const SESSION_FILE_NAME = 'telegram.session';

export class AccountSessionStore {
  private readonly rootDirectory: string;

  public constructor(sessionDirectory: string) {
    this.rootDirectory = path.resolve(sessionDirectory);
    fs.mkdirSync(this.rootDirectory, { recursive: true, mode: 0o700 });
  }

  public getAccountDirectory(accountKey: string): string {
    this.assertSafeAccountKey(accountKey);
    return path.join(this.rootDirectory, accountKey);
  }

  public getSessionPath(accountKey: string): string {
    return path.join(this.getAccountDirectory(accountKey), SESSION_FILE_NAME);
  }

  public getChannelSyncStatePath(accountKey: string): string {
    return path.join(this.getAccountDirectory(accountKey), 'telegram-channel-sync-state.json');
  }

  public has(accountKey: string): boolean {
    return fs.existsSync(this.getSessionPath(accountKey));
  }

  public read(accountKey: string): string | undefined {
    const sessionPath = this.getSessionPath(accountKey);

    if (!fs.existsSync(sessionPath)) {
      return undefined;
    }

    const session = fs.readFileSync(sessionPath, 'utf8').trim();

    if (session.length === 0) {
      throw new Error('Stored Telegram session is empty');
    }

    return session;
  }

  public write(accountKey: string, session: string): void {
    if (session.trim().length === 0) {
      throw new Error('Refusing to persist an empty Telegram session');
    }

    const accountDirectory = this.getAccountDirectory(accountKey);
    const sessionPath = this.getSessionPath(accountKey);
    const temporaryPath = `${sessionPath}.tmp`;
    fs.mkdirSync(accountDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporaryPath, session, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, sessionPath);
    fs.chmodSync(sessionPath, 0o600);
  }

  public remove(accountKey: string): void {
    const accountDirectory = this.getAccountDirectory(accountKey);
    fs.rmSync(accountDirectory, { recursive: true, force: true });
  }

  private assertSafeAccountKey(accountKey: string): void {
    if (!ACCOUNT_KEY_PATTERN.test(accountKey)) {
      throw new Error('Unsafe account key for session storage');
    }
  }
}
