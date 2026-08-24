import { AccountService } from '../accounts/account.service.js';
import { TelegramClientRegistry } from '../user-client/telegram-client.registry.js';
import type {
  ChannelAccessGateway,
  ChannelRecord,
  ResolvedTelegramChannel,
} from './channel.types.js';
import type { TelegramIncomingMessage } from '../rules/rule.types.js';

export class GramJsChannelGateway implements ChannelAccessGateway {
  public constructor(
    private readonly accounts: AccountService,
    private readonly clients: TelegramClientRegistry,
  ) {}

  public resolve(accountKey: string, identifier: string): Promise<ResolvedTelegramChannel> {
    const account = this.accounts.get(accountKey);
    if (!account.enabled) throw new Error(`Account ${account.nickname} is disabled`);
    const client = this.clients.get(accountKey);
    if (client === undefined || !client.getStatus().connected) {
      throw new Error(`Account ${account.nickname} is not connected`);
    }
    return client.resolveChannel(normalizeChannelIdentifier(identifier));
  }

  public subscribe(
    accountKey: string,
    channel: ChannelRecord,
    onMessage: (event: TelegramIncomingMessage) => Promise<void>,
    onError: (error: unknown) => void,
  ): Promise<() => Promise<void>> {
    this.accounts.get(accountKey);
    const client = this.clients.get(accountKey);
    if (client === undefined || !client.getStatus().connected) {
      throw new Error(`Telegram client is not connected for ${accountKey}`);
    }
    return client.subscribeChannel(
      channel.username ?? channel.telegramChannelId,
      channel.telegramChannelId,
      onMessage,
      onError,
    );
  }
}

export function normalizeChannelIdentifier(input: string): string {
  const normalized = input.trim();
  if (normalized.length === 0 || normalized.length > 200) {
    throw new Error('Channel identifier must contain 1-200 characters');
  }
  if (/^(?:https?:\/\/)?t\.me\/\+/i.test(normalized) || /joinchat\//i.test(normalized)) {
    throw new Error('Invite links are not supported because M3 never auto-joins channels');
  }
  const publicLink = normalized.match(/^(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{5,})\/?$/i);
  if (publicLink?.[1] !== undefined) return `@${publicLink[1]}`;
  if (/^@[A-Za-z0-9_]{5,}$/.test(normalized)) return normalized;
  if (/^[A-Za-z][A-Za-z0-9_]{4,}$/.test(normalized)) return `@${normalized}`;
  if (/^-?\d{5,20}$/.test(normalized)) return normalized;
  throw new Error('Use @username, a public t.me link, or a numeric channel ID');
}
