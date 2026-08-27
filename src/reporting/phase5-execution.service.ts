import type { ReactionExecutor } from '../reaction/reaction.executor.js';
import type { ReactionResult } from '../reaction/reaction-result.js';
import type { ReplyResult } from '../reply/reply-result.js';
import type {
  ActionReportContext,
  ActionReportDelivery,
} from './action-report.js';
import type { ActionReportWriter } from './action-reporter.js';

export interface Phase5ExecutionInput {
  readonly reply: ReplyResult;
  readonly context: ActionReportContext;
}

export interface Phase5ExecutionResult {
  readonly reply: ReplyResult;
  readonly reaction: ReactionResult;
  readonly report: ActionReportDelivery;
}

type ReactionRunner = Pick<ReactionExecutor, 'execute'>;

export class Phase5ExecutionService {
  private readonly executions = new Map<string, Promise<Phase5ExecutionResult>>();

  public constructor(
    private readonly reactions: ReactionRunner,
    private readonly reports: ActionReportWriter,
  ) {}

  public process(input: Phase5ExecutionInput): Promise<Phase5ExecutionResult> {
    const key = executionKey(input.reply);
    const existing = this.executions.get(key);
    if (existing !== undefined) return existing;
    const execution = this.processOnce(input);
    this.executions.set(key, execution);
    return execution;
  }

  public processAll(inputs: readonly Phase5ExecutionInput[]): Promise<Phase5ExecutionResult[]> {
    return Promise.all(inputs.map((input) => this.process(input)));
  }

  private async processOnce(input: Phase5ExecutionInput): Promise<Phase5ExecutionResult> {
    const reaction = await this.reactions.execute(input.reply);
    const report = await this.reports.report({
      reply: input.reply,
      reaction,
      context: input.context,
    });
    return { reply: input.reply, reaction, report };
  }
}

function executionKey(reply: ReplyResult): string {
  const attemptIdentity = reply.replyMessageId === undefined
    ? `failed:${reply.executedAt}`
    : `reply:${reply.replyMessageId}`;
  return `${reply.accountId}:${reply.channelId}:${reply.sourceMessageId}:${attemptIdentity}`;
}
