import type { AutoReplyGateway } from '../automation/automation.types.js';
import type { DispatchJob } from '../detection/dispatch-job.js';
import type { AppLogger } from '../logging/logger.js';
import { classifyReplyError, ReplyExecutionError } from './reply-error.js';
import type { ReplyConfigurationResolver } from './reply-configuration.service.js';
import type { ReplyResult } from './reply-result.js';

export interface DelayScheduler {
  wait(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

const defaultScheduler: DelayScheduler = {
  wait(milliseconds, signal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(abortedError());
        return;
      }
      const timer = setTimeout(resolve, milliseconds);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(abortedError());
      }, { once: true });
    });
  },
};

/** Executes already-planned jobs without repeating detection or account selection. */
export class ReplyExecutor {
  private readonly accountQueues = new Map<number, Promise<void>>();
  private readonly executions = new Map<string, Promise<ReplyResult>>();
  private readonly shutdownController = new AbortController();

  public constructor(
    private readonly configuration: ReplyConfigurationResolver,
    private readonly telegram: AutoReplyGateway,
    private readonly logger: AppLogger,
    private readonly scheduler: DelayScheduler = defaultScheduler,
  ) {}

  public execute(job: DispatchJob): Promise<ReplyResult> {
    const executionKey = dispatchExecutionKey(job);
    const existing = this.executions.get(executionKey);
    if (existing !== undefined) return existing;

    const previous = this.accountQueues.get(job.accountId) ?? Promise.resolve();
    const execution = previous.then(() => this.executeJob(job));
    const queueTail = execution.then(
      () => undefined,
      () => undefined,
    );

    this.executions.set(executionKey, execution);
    this.accountQueues.set(job.accountId, queueTail);
    void queueTail.finally(() => {
      if (this.accountQueues.get(job.accountId) === queueTail) {
        this.accountQueues.delete(job.accountId);
      }
    });
    return execution;
  }

  public executeAll(jobs: readonly DispatchJob[]): Promise<ReplyResult[]> {
    return Promise.all(jobs.map((job) => this.execute(job)));
  }

  public shutdown(): void {
    this.shutdownController.abort();
  }

  private async executeJob(job: DispatchJob): Promise<ReplyResult> {
    try {
      if (!Number.isSafeInteger(job.sourceMessageId) || job.sourceMessageId <= 0) {
        throw new ReplyExecutionError(
          'INVALID_SOURCE_MESSAGE_ID',
          `Invalid source message ID: ${job.sourceMessageId}`,
        );
      }

      const configuration = this.configuration.resolve(job);
      await this.scheduler.wait(configuration.delayMs, this.shutdownController.signal);
      if (this.shutdownController.signal.aborted) throw abortedError();
      if (!this.telegram.isAvailable(configuration.accountKey)) {
        throw new ReplyExecutionError(
          'ACCOUNT_DISCONNECTED',
          `Account ${configuration.accountKey} is not connected`,
        );
      }

      const sentReply = await this.telegram.sendComment(
        configuration.accountKey,
        configuration.channelIdentifier,
        job.sourceMessageId,
        configuration.templateBody,
      );
      if (!Number.isSafeInteger(sentReply.messageId) || sentReply.messageId <= 0) {
        throw new ReplyExecutionError(
          'REPLY_MESSAGE_ID_MISSING',
          'Telegram did not return a valid reply message ID',
        );
      }

      const result: ReplyResult = {
        success: true,
        accountId: job.accountId,
        channelId: job.channelId,
        sourceMessageId: job.sourceMessageId,
        replyMessageId: sentReply.messageId,
        matchedTriggers: [...job.matchedTriggers],
        executedAt: new Date().toISOString(),
      };
      this.logger.info(
        {
          account: configuration.accountKey,
          channel: configuration.channelIdentifier,
          sourceMessageId: job.sourceMessageId,
          replyMessageId: sentReply.messageId,
          template: configuration.templateId,
          action: 'reply_execution',
          status: 'sent',
        },
        'Reply executed successfully',
      );
      return result;
    } catch (error) {
      const classified = classifyReplyError(error);
      const result: ReplyResult = {
        success: false,
        accountId: job.accountId,
        channelId: job.channelId,
        sourceMessageId: job.sourceMessageId,
        matchedTriggers: [...job.matchedTriggers],
        errorCode: classified.errorCode,
        errorMessage: classified.errorMessage,
        executedAt: new Date().toISOString(),
      };
      this.logger.error(
        {
          account: job.accountId,
          channel: job.channelId,
          sourceMessageId: job.sourceMessageId,
          action: 'reply_execution',
          status: 'failed',
          errorCode: classified.errorCode,
          errorReason: classified.errorMessage,
        },
        'Reply execution failed',
      );
      return result;
    }
  }
}

function dispatchExecutionKey(job: DispatchJob): string {
  return `${job.accountId}:${job.channelId}:${job.sourceMessageId}`;
}

function abortedError(): ReplyExecutionError {
  return new ReplyExecutionError('EXECUTION_ABORTED', 'Reply execution was aborted');
}
