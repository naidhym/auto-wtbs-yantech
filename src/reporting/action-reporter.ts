import type { AccountService } from '../accounts/account.service.js';
import type { ChannelRepository } from '../channels/channel.repository.js';
import { errorReason, type AppLogger } from '../logging/logger.js';
import type {
  ActionReport,
  ActionReportDelivery,
  ActionReportInput,
  SavedMessagesGateway,
} from './action-report.js';

type AccountLookup = Pick<AccountService, 'getById'>;
type ChannelLookup = Pick<ChannelRepository, 'get'>;

export interface ActionReportWriter {
  report(input: ActionReportInput): Promise<ActionReportDelivery>;
}

export class ActionReporter implements ActionReportWriter {
  public constructor(
    private readonly accounts: AccountLookup,
    private readonly channels: ChannelLookup,
    private readonly savedMessages: SavedMessagesGateway,
    private readonly logger: AppLogger,
  ) {}

  public async report(input: ActionReportInput): Promise<ActionReportDelivery> {
    const deliveredAt = new Date().toISOString();
    const account = this.accounts.getById(input.reply.accountId);
    if (account === undefined) {
      return this.deliveryFailure(
        input.reply.accountId,
        'ACCOUNT_NOT_FOUND',
        `Account not found: ${input.reply.accountId}`,
        deliveredAt,
      );
    }
    const channel = this.channels.get(input.reply.channelId);
    if (channel === undefined) {
      return this.deliveryFailure(
        input.reply.accountId,
        'CHANNEL_NOT_FOUND',
        `Channel not found: ${input.reply.channelId}`,
        deliveredAt,
        account.accountKey,
      );
    }

    const sourceMessageLink = input.context.sourceMessageLink ??
      createPublicSourceMessageLink(channel.username, input.reply.sourceMessageId);
    const report: ActionReport = {
      accountId: account.id,
      accountKey: account.accountKey,
      accountNickname: account.nickname,
      channelId: channel.id,
      channelTitle: channel.title,
      senderDisplayName: input.context.senderDisplayName.trim() || 'Unknown',
      matchedTriggers: [...input.reply.matchedTriggers],
      sourceMessageId: input.reply.sourceMessageId,
      ...(sourceMessageLink === undefined ? {} : { sourceMessageLink }),
      replyStatus: input.reply.success ? 'sent' : 'failed',
      ...(input.reply.replyMessageId === undefined
        ? {}
        : { replyMessageId: input.reply.replyMessageId }),
      ...(input.reply.errorCode === undefined ? {} : { replyErrorCode: input.reply.errorCode }),
      ...(input.reply.errorMessage === undefined
        ? {}
        : { replyErrorMessage: input.reply.errorMessage }),
      reactionStatus: input.reaction.status,
      ...(input.reaction.reactionType === undefined
        ? {}
        : { reactionType: input.reaction.reactionType }),
      ...(input.reaction.targetMessageId === undefined
        ? {}
        : { reactionTargetMessageId: input.reaction.targetMessageId }),
      ...(input.reaction.errorCode === undefined
        ? {}
        : { reactionErrorCode: input.reaction.errorCode }),
      ...(input.reaction.errorMessage === undefined
        ? {}
        : { reactionErrorMessage: input.reaction.errorMessage }),
      delayMs: input.context.delayMs,
      replyExecutedAt: input.reply.executedAt,
      reactionExecutedAt: input.reaction.executedAt,
      generatedAt: deliveredAt,
    };

    try {
      await this.savedMessages.sendToSavedMessages(account.accountKey, {
        text: formatActionReport(report),
        ...(sourceMessageLink === undefined ? {} : { sourceMessageLink }),
      });
      this.logger.info(
        {
          account: account.accountKey,
          channel: channel.telegramChannelId,
          sourceMessageId: input.reply.sourceMessageId,
          replyMessageId: input.reply.replyMessageId,
          action: 'action_report',
          status: 'delivered',
          destination: 'saved_messages',
        },
        'Action report delivered to executing account Saved Messages',
      );
      return {
        delivered: true,
        destination: 'saved_messages',
        accountId: account.id,
        accountKey: account.accountKey,
        report,
        deliveredAt,
      };
    } catch (error) {
      return this.deliveryFailure(
        account.id,
        'REPORT_DELIVERY_FAILED',
        errorReason(error),
        deliveredAt,
        account.accountKey,
        report,
      );
    }
  }

  private deliveryFailure(
    accountId: number,
    errorCode: NonNullable<ActionReportDelivery['errorCode']>,
    errorMessage: string,
    deliveredAt: string,
    accountKey?: string,
    report?: ActionReport,
  ): ActionReportDelivery {
    this.logger.error(
      {
        account: accountKey ?? accountId,
        action: 'action_report',
        status: 'failed',
        destination: 'saved_messages',
        errorCode,
        errorReason: errorMessage,
      },
      'Action report delivery failed',
    );
    return {
      delivered: false,
      destination: 'saved_messages',
      accountId,
      ...(accountKey === undefined ? {} : { accountKey }),
      ...(report === undefined ? {} : { report }),
      errorCode,
      errorMessage,
      deliveredAt,
    };
  }
}

export function formatActionReport(report: ActionReport): string {
  const replyLines = report.replyStatus === 'sent'
      ? [
        'Reply: ✅',
        `Reply message ID: ${String(report.replyMessageId ?? '—')}`,
      ]
    : [
        'Reply: ❌',
        `Reply reason: ${report.replyErrorMessage ?? report.replyErrorCode ?? 'Unknown reply failure'}`,
      ];
  const reactionLines = report.reactionStatus === 'sent'
    ? [
        'Reaction: ✅',
        `Reaction type: ${report.reactionType ?? '—'}`,
      ]
    : report.reactionStatus === 'failed'
      ? [
          'Reaction: ❌',
          ...(report.reactionType === undefined ? [] : [`Reaction type: ${report.reactionType}`]),
          `Reaction reason: ${report.reactionErrorMessage ?? report.reactionErrorCode ?? 'Unknown reaction failure'}`,
        ]
      : report.reactionStatus === 'disabled'
        ? ['Reaction: — (disabled)']
        : ['Reaction: —'];

  return [
    '🤖 AUTO WTB ACTION REPORT',
    '',
    `Account: ${report.accountNickname}`,
    `Channel: ${report.channelTitle}`,
    `Sender: ${report.senderDisplayName}`,
    `Matched triggers: ${report.matchedTriggers.join(', ') || '—'}`,
    `Source message ID: ${report.sourceMessageId}`,
    ...(report.sourceMessageLink === undefined
      ? []
      : [`Source message: ${report.sourceMessageLink}`]),
    ...replyLines,
    ...reactionLines,
    `Delay used: ${formatDelay(report.delayMs)}`,
    `Execution time: ${report.replyExecutedAt}`,
  ].join('\n');
}

function createPublicSourceMessageLink(
  username: string | undefined,
  sourceMessageId: number,
): string | undefined {
  const normalized = username?.replace(/^@/, '');
  if (
    normalized === undefined ||
    !/^[A-Za-z0-9_]{5,}$/.test(normalized) ||
    !Number.isSafeInteger(sourceMessageId) ||
    sourceMessageId < 1
  ) {
    return undefined;
  }
  return `https://t.me/${normalized}/${sourceMessageId}`;
}

function formatDelay(delayMs: number): string {
  return `${String(delayMs / 1_000)}s`;
}
