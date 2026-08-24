import { AccountService } from '../accounts/account.service.js';
import { TelegramClientRegistry } from '../user-client/telegram-client.registry.js';
import { AccountAutomationSettingsService } from './account-automation-settings.service.js';
import type {
  AccountNotification,
  AccountNotificationGateway,
  AutoReplyGateway,
  SentReply,
} from './automation.types.js';

export class GramJsAutoReplyGateway implements AutoReplyGateway {
  public constructor(
    private readonly accounts: AccountService,
    private readonly clients: TelegramClientRegistry,
  ) {}

  public isAvailable(accountKey: string): boolean {
    const account = this.accounts.get(accountKey);
    return account.enabled && this.clients.get(accountKey)?.getStatus().connected === true;
  }

  public sendComment(
    accountKey: string,
    channelIdentifier: string,
    sourceMessageId: number,
    text: string,
  ): Promise<SentReply> {
    const client = this.requireClient(accountKey);
    return client.sendChannelComment(channelIdentifier, sourceMessageId, text);
  }

  private requireClient(accountKey: string) {
    const account = this.accounts.get(accountKey);
    if (!account.enabled) throw new Error(`Account ${account.nickname} is disabled`);
    const client = this.clients.get(accountKey);
    if (client === undefined || !client.getStatus().connected) {
      throw new Error(`Account ${account.nickname} is not connected`);
    }
    return client;
  }
}

export class GramJsAccountNotificationGateway implements AccountNotificationGateway {
  public constructor(
    private readonly accounts: AccountService,
    private readonly clients: TelegramClientRegistry,
    private readonly settings: AccountAutomationSettingsService,
  ) {}

  public async notify(accountKey: string, notification: AccountNotification): Promise<boolean> {
    const account = this.accounts.get(accountKey);
    if (!account.enabled) return false;
    const client = this.clients.get(accountKey);
    if (client === undefined || !client.getStatus().connected) return false;
    const target = this.settings.get(accountKey).notificationTarget;
    if (target === undefined) return false;

    if (notification.type === 'reply_sent') {
      await client.sendOperationalNotification(target, {
        text: [
          '🤖 AUTO WTB SENT',
          '',
          `Account: ${notification.accountNickname ?? account.nickname}`,
          `Channel: ${notification.channelTitle}`,
          `Trigger: ${notification.trigger}`,
        ].join('\n'),
        link: {
          label: '🔗 Open Source Message',
          url: notification.sourceMessageLink,
        },
      });
      return true;
    }

    await client.sendOperationalNotification(target, {
      text: [
        '❌ AUTO WTB FAILED',
        '',
        `Account: ${notification.accountNickname ?? account.nickname}`,
        `Channel: ${notification.channelTitle}`,
        `Reason: ${notification.reason}`,
      ].join('\n'),
    });
    return true;
  }
}
