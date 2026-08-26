import { AccountService } from '../accounts/account.service.js';
import { TelegramClientRegistry } from '../user-client/telegram-client.registry.js';
import type {
  AccountNotification,
  AccountNotificationGateway,
  AutoReplyGateway,
  SentReply,
  SourceReactionTarget,
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

  public reactToSourceMessage(
    accountKey: string,
    target: SourceReactionTarget,
  ) {
    const client = this.requireClient(accountKey);
    return client.reactToChannelMessage(target.channelIdentifier, target.replyMessageId);
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
  ) {}

  public async notify(accountKey: string, notification: AccountNotification): Promise<boolean> {
    const account = this.accounts.get(accountKey);
    if (!account.enabled) return false;
    const client = this.clients.get(accountKey);
    if (client === undefined || !client.getStatus().connected) return false;
    if (notification.type === 'reply_sent') {
      await client.sendOperationalNotification('me', {
        text: [
          '🤖 AUTO WTB SENT',
          '',
          `Account: ${notification.accountNickname ?? account.nickname}`,
          `Channel: ${notification.channelTitle}`,
          `Trigger: ${notification.trigger}`,
          `Source message ID: ${notification.sourceMessageId}`,
          '',
          'Reply: SUCCESS',
          `Reaction: ${formatReactionStatus(notification.reactionStatus, notification.reactionReason)}`,
        ].join('\n'),
        link: {
          label: '🔗 Open Source Message',
          url: notification.sourceMessageLink,
        },
      });
      return true;
    }

    await client.sendOperationalNotification('me', {
      text: [
        '❌ AUTO WTB FAILED',
        '',
        `Account: ${notification.accountNickname ?? account.nickname}`,
        `Channel: ${notification.channelTitle}`,
        ...(notification.trigger === undefined ? [] : [`Trigger: ${notification.trigger}`]),
        ...(notification.sourceMessageId === undefined
          ? []
          : [`Source message ID: ${notification.sourceMessageId}`]),
        '',
        'Reply: FAILED',
        `Reason: ${notification.reason}`,
      ].join('\n'),
      ...(notification.sourceMessageLink === undefined
        ? {}
        : {
            link: {
              label: 'Open Source Message',
              url: notification.sourceMessageLink,
            },
          }),
    });
    return true;
  }
}

function formatReactionStatus(
  status: 'sent' | 'skipped' | 'failed',
  reason: string | undefined,
): string {
  if (status === 'sent') return 'SENT';
  if (reason === undefined) return status.toUpperCase();
  return `${status.toUpperCase()} (${reason})`;
}
