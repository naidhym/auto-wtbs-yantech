import type { AccountService } from '../accounts/account.service.js';
import type { AccountAutomationSettingsService } from '../automation/account-automation-settings.service.js';
import type { ChannelRepository } from '../channels/channel.repository.js';
import type { ReplyResult } from '../reply/reply-result.js';
import { parseTelegramReactionType } from '../shared/telegram-reaction.js';
import { ReactionExecutionError } from './reaction-error.js';

export interface ReactionExecutionConfiguration {
  readonly accountKey: string;
  readonly channelIdentifier: string;
  readonly reactionEnabled: boolean;
  readonly reactionType: string;
  readonly targetMessageId: number;
}

export interface ReactionConfigurationResolver {
  resolve(reply: ReplyResult): ReactionExecutionConfiguration;
}

type AccountLookup = Pick<AccountService, 'getById'>;
type ChannelLookup = Pick<ChannelRepository, 'get'>;
type SettingsLookup = Pick<AccountAutomationSettingsService, 'get'>;

export class ReactionConfigurationService implements ReactionConfigurationResolver {
  public constructor(
    private readonly accounts: AccountLookup,
    private readonly channels: ChannelLookup,
    private readonly settings: SettingsLookup,
  ) {}

  public resolve(reply: ReplyResult): ReactionExecutionConfiguration {
    if (reply.replyMessageId === undefined || reply.replyMessageId < 1) {
      throw new ReactionExecutionError(
        'REPLY_MESSAGE_ID_MISSING',
        'Successful reply result does not contain a valid reply message ID',
      );
    }
    const account = this.accounts.getById(reply.accountId);
    if (account === undefined) {
      throw new ReactionExecutionError('ACCOUNT_NOT_FOUND', `Account not found: ${reply.accountId}`);
    }
    if (!account.enabled) {
      throw new ReactionExecutionError('ACCOUNT_DISABLED', `Account ${account.nickname} is disabled`);
    }
    const settings = this.settings.get(account.accountKey);
    if (settings.accountId !== reply.accountId || settings.accountKey !== account.accountKey) {
      throw new ReactionExecutionError(
        'ACCOUNT_CONFIGURATION_MISMATCH',
        `Reaction settings do not belong to account ${reply.accountId}`,
      );
    }
    const channel = this.channels.get(reply.channelId);
    if (channel === undefined) {
      throw new ReactionExecutionError('CHANNEL_NOT_FOUND', `Channel not found: ${reply.channelId}`);
    }
    return {
      accountKey: account.accountKey,
      channelIdentifier: channel.telegramChannelId,
      reactionEnabled: settings.autoReaction,
      reactionType: parseTelegramReactionType(settings.reactionType),
      targetMessageId: reply.replyMessageId,
    };
  }
}
