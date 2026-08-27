import type { AccountService } from '../accounts/account.service.js';
import type { AccountRecord } from '../accounts/account.types.js';
import type { AccountAutomationSettingsService } from '../automation/account-automation-settings.service.js';
import type { AccountAutomationSettings } from '../automation/automation.types.js';
import type { ChannelRepository } from '../channels/channel.repository.js';
import type { ChannelRecord } from '../channels/channel.types.js';
import type { DispatchJob } from '../detection/dispatch-job.js';
import type { ReplyTemplateService } from '../rules/reply-template.service.js';
import type { ReplyTemplateRecord } from '../rules/rule.types.js';
import { ReplyExecutionError } from './reply-error.js';

export const MINIMUM_REPLY_DELAY_MS = 100;
export const MAXIMUM_REPLY_DELAY_MS = 600_000;

export interface ReplyExecutionConfiguration {
  readonly accountKey: string;
  readonly channelIdentifier: string;
  readonly templateId: number;
  readonly templateBody: string;
  readonly delayMs: number;
}

export interface ReplyConfigurationResolver {
  resolve(job: DispatchJob): ReplyExecutionConfiguration;
}

type AccountLookup = Pick<AccountService, 'getById'>;
type ChannelLookup = Pick<ChannelRepository, 'get'>;
type TemplateLookup = Pick<ReplyTemplateService, 'getActiveTemplate'>;
type SettingsLookup = Pick<AccountAutomationSettingsService, 'get'>;

/** Resolves only the account/channel configuration for an already-planned job. */
export class ReplyConfigurationService implements ReplyConfigurationResolver {
  public constructor(
    private readonly accounts: AccountLookup,
    private readonly channels: ChannelLookup,
    private readonly templates: TemplateLookup,
    private readonly settings: SettingsLookup,
  ) {}

  public resolve(job: DispatchJob): ReplyExecutionConfiguration {
    const account = this.requireAccount(job.accountId);
    const settings = this.settings.get(account.accountKey);
    this.assertSettingsOwner(job.accountId, settings);
    this.assertDelay(settings.replyDelayMs);
    const template = this.templates.getActiveTemplate(account.accountKey);
    this.assertTemplateOwner(job.accountId, account.accountKey, template);
    const channel = this.requireChannel(job.channelId);

    return {
      accountKey: account.accountKey,
      channelIdentifier: channel.telegramChannelId,
      templateId: template.id,
      templateBody: template.body,
      delayMs: settings.replyDelayMs,
    };
  }

  private requireAccount(accountId: number): AccountRecord {
    const account = this.accounts.getById(accountId);
    if (account === undefined) {
      throw new ReplyExecutionError('ACCOUNT_NOT_FOUND', `Account not found: ${accountId}`);
    }
    if (!account.enabled) {
      throw new ReplyExecutionError('ACCOUNT_DISABLED', `Account ${account.nickname} is disabled`);
    }
    return account;
  }

  private requireChannel(channelId: number): ChannelRecord {
    const channel = this.channels.get(channelId);
    if (channel === undefined) {
      throw new ReplyExecutionError('CHANNEL_NOT_FOUND', `Channel not found: ${channelId}`);
    }
    return channel;
  }

  private assertSettingsOwner(
    accountId: number,
    settings: AccountAutomationSettings,
  ): void {
    if (settings.accountId !== accountId) {
      throw new ReplyExecutionError(
        'ACCOUNT_CONFIGURATION_MISMATCH',
        `Reply settings belong to account ${settings.accountId}, not account ${accountId}`,
      );
    }
  }

  private assertTemplateOwner(
    accountId: number,
    accountKey: string,
    template: ReplyTemplateRecord | undefined,
  ): asserts template is ReplyTemplateRecord {
    if (template === undefined) {
      throw new ReplyExecutionError(
        'ACTIVE_TEMPLATE_NOT_FOUND',
        `No active reply template for account ${accountKey}`,
      );
    }
    if (template.accountId !== accountId || template.accountKey !== accountKey) {
      throw new ReplyExecutionError(
        'ACCOUNT_CONFIGURATION_MISMATCH',
        `Reply template ${template.id} does not belong to account ${accountId}`,
      );
    }
  }

  private assertDelay(delayMs: number): void {
    if (
      !Number.isSafeInteger(delayMs) ||
      delayMs < MINIMUM_REPLY_DELAY_MS ||
      delayMs > MAXIMUM_REPLY_DELAY_MS
    ) {
      throw new ReplyExecutionError(
        'INVALID_REPLY_DELAY',
        'Reply delay must be between 0.1 and 600 seconds',
      );
    }
  }
}
