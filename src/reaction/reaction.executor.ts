import type { ReplyResult } from '../reply/reply-result.js';
import type { AppLogger } from '../logging/logger.js';
import type { ReactionConfigurationResolver } from './reaction-configuration.service.js';
import { classifyReactionError, ReactionExecutionError } from './reaction-error.js';
import type { ReactionResult, ReplyReactionGateway } from './reaction-result.js';

export class ReactionExecutor {
  public constructor(
    private readonly configuration: ReactionConfigurationResolver,
    private readonly telegram: ReplyReactionGateway,
    private readonly logger: AppLogger,
  ) {}

  public async execute(reply: ReplyResult): Promise<ReactionResult> {
    if (!reply.success) {
      return {
        status: 'not_applicable',
        attempted: false,
        success: false,
        skippedReason: 'reply_failed',
        executedAt: new Date().toISOString(),
      };
    }

    // A successful reply enters reaction processing. Disabled configuration is
    // the only non-attempt state; validation/transport failures are failures.
    const attempted = true;
    let reactionType: string | undefined;
    let targetMessageId: number | undefined;
    try {
      const configuration = this.configuration.resolve(reply);
      reactionType = configuration.reactionType;
      targetMessageId = configuration.targetMessageId;
      if (!configuration.reactionEnabled) {
        return {
          status: 'disabled',
          attempted: false,
          success: true,
          reactionType,
          skippedReason: 'reaction_disabled',
          executedAt: new Date().toISOString(),
        };
      }

      const attempt = await this.telegram.reactToReply(configuration.accountKey, {
        channelIdentifier: configuration.channelIdentifier,
        replyMessageId: configuration.targetMessageId,
        reactionType: configuration.reactionType,
      });
      if (attempt.status === 'unavailable') {
        throw new ReactionExecutionError(
          'REACTION_UNAVAILABLE',
          attempt.reason ?? 'Configured reaction is unavailable for the reply message',
        );
      }
      const result: ReactionResult = {
        status: 'sent',
        attempted: true,
        success: true,
        reactionType,
        targetMessageId,
        executedAt: new Date().toISOString(),
      };
      this.logger.info(
        {
          account: reply.accountId,
          channel: reply.channelId,
          sourceMessageId: reply.sourceMessageId,
          replyMessageId: targetMessageId,
          reactionType,
          action: 'reply_reaction',
          status: 'sent',
        },
        'Configured reaction sent to the account reply',
      );
      return result;
    } catch (error) {
      const classified = classifyReactionError(error);
      const result: ReactionResult = {
        status: 'failed',
        attempted,
        success: false,
        ...(reactionType === undefined ? {} : { reactionType }),
        ...(targetMessageId === undefined ? {} : { targetMessageId }),
        errorCode: classified.errorCode,
        errorMessage: classified.errorMessage,
        executedAt: new Date().toISOString(),
      };
      this.logger.error(
        {
          account: reply.accountId,
          channel: reply.channelId,
          sourceMessageId: reply.sourceMessageId,
          replyMessageId: targetMessageId,
          reactionType,
          action: 'reply_reaction',
          status: 'failed',
          errorCode: classified.errorCode,
          errorReason: classified.errorMessage,
        },
        'Configured reaction failed',
      );
      return result;
    }
  }
}
