import { errorReason, type AppLogger } from '../logging/logger.js';
import { ChannelRepository } from './channel.repository.js';
import type {
  ChannelAccessGateway,
  ChannelAssignmentRecord,
  ChannelMessageProcessor,
  ChannelRecord,
} from './channel.types.js';

interface ActiveListener {
  readonly assignment: ChannelAssignmentRecord;
  readonly channel: ChannelRecord;
  readonly unsubscribe: () => Promise<void>;
}

export interface ListenerStartSummary {
  readonly eligible: number;
  readonly active: number;
  readonly failed: number;
}

export class ChannelListenerService {
  private readonly active = new Map<number, ActiveListener>();
  private readonly inFlight = new Set<Promise<void>>();
  private processor: ChannelMessageProcessor | undefined;
  private acceptingMessages = true;

  public constructor(
    private readonly repository: ChannelRepository,
    private readonly gateway: ChannelAccessGateway,
    private readonly logger: AppLogger,
    processor?: ChannelMessageProcessor,
  ) {
    this.processor = processor;
  }

  public setProcessor(processor: ChannelMessageProcessor): void {
    this.processor = processor;
  }

  public async startAll(ownerTelegramId: string): Promise<ListenerStartSummary> {
    for (const { assignment, channel, accountEnabled, accountStatus } of this.repository.listListenerAssignmentAudit(ownerTelegramId)) {
      const eligible = assignment.enabled && channel.enabled && !channel.automationBlocked && accountEnabled;
      this.logger.info(
        {
          account: assignment.accountKey,
          channel: channel.id,
          action: 'diagnostic_channel_assignment_loaded',
          status: eligible ? 'eligible' : 'ineligible',
          reason: eligible ? 'all_listener_eligibility_gates_passed' : listenerIneligibilityReason(assignment, channel, accountEnabled),
          assignmentId: assignment.id,
          accountId: assignment.accountId,
          accountSessionKey: assignment.accountKey,
          channelId: channel.id,
          telegramChannelId: channel.telegramChannelId,
          username: channel.username,
          channelTitle: channel.title,
          nativeClientInstanceId: this.nativeClientInstanceId(assignment.accountKey),
          assignmentStatus: assignment.status,
          assignmentEnabled: assignment.enabled,
          channelStatus: channel.status,
          channelEnabled: channel.enabled,
          automationBlocked: channel.automationBlocked === true,
          accountEnabled,
          accountStatus,
        },
        'Diagnostic channel assignment loaded',
      );
    }
    const eligible = this.repository.listEffectiveAssignments(ownerTelegramId);
    const results = await Promise.allSettled(
      eligible.map(async ({ assignment, channel }) => this.start(assignment, channel)),
    );
    const failed = results.filter((result) => result.status === 'rejected').length;
    const summary = {
      eligible: eligible.length,
      active: eligible.filter(({ assignment }) => this.active.has(assignment.id)).length,
      failed,
    };
    this.logger[failed === 0 ? 'info' : 'warn'](
      {
        action: 'channel_listener_start_summary',
        status: failed === 0 ? 'ready' : 'partial_failure',
        ...summary,
      },
      'Channel listener startup completed',
    );
    return summary;
  }

  public async start(
    assignment: ChannelAssignmentRecord,
    channel: ChannelRecord,
  ): Promise<void> {
    if (
      !this.acceptingMessages ||
      this.active.has(assignment.id) ||
      !assignment.enabled ||
      !channel.enabled ||
      channel.automationBlocked === true
    ) {
      this.logger.info(
        {
          account: assignment.accountKey,
          channel: channel.id,
          action: 'diagnostic_listener_registration',
          status: 'skipped',
          reason: listenerIneligibilityReason(assignment, channel, true, this.acceptingMessages, this.active.has(assignment.id)),
          channelDatabaseId: channel.id,
          expectedTelegramChannelId: channel.telegramChannelId,
          nativeClientInstanceId: this.nativeClientInstanceId(assignment.accountKey),
          assignmentId: assignment.id,
        },
        'Diagnostic listener registration skipped',
      );
      return;
    }

    try {
      const unsubscribe = await this.gateway.subscribe(
        assignment.accountKey,
        assignment,
        channel,
        async (message) => {
          if (!this.acceptingMessages) return;
          this.logger.info(
            {
              account: assignment.accountKey,
              channel: channel.id,
              action: 'channel_message_received',
              status: 'received',
              telegramChannelId: channel.telegramChannelId,
              assignmentId: assignment.id,
              sourceMessageId: message.sourceMessageId,
              nativeClientInstanceId: this.nativeClientInstanceId(assignment.accountKey),
            },
            'Channel message received from Telegram (live event)',
          );
          await this.track(async () => {
            try {
              await this.processor?.process({ assignment, channel, message });
            } catch (error) {
              this.logger.error(
                {
                  account: assignment.accountKey,
                  channel: channel.id,
                  action: 'channel_message_processing_error',
                  status: 'failed',
                  errorReason: errorReason(error),
                  assignmentId: assignment.id,
                  accountId: assignment.accountId,
                  channelId: channel.id,
                  telegramChannelId: channel.telegramChannelId,
                  ...(message.sourceMessageId === undefined ? {} : { sourceMessageId: message.sourceMessageId }),
                  errorName: error instanceof Error ? error.name : 'UnknownError',
                  errorMessage: errorReason(error),
                },
                'Channel message processing failed without stopping its listener',
              );
            }
          });
        },
        async (error) => this.handleListenerError(assignment, channel, error),
      );
      this.active.set(assignment.id, { assignment, channel, unsubscribe });
      this.repository.setAssignmentStatus(assignment.id, 'healthy');
      this.logger.info(
        {
          account: assignment.accountKey,
          channel: channel.id,
          action: 'channel_listener_start',
          status: 'started',
          channelDatabaseId: channel.id,
          expectedTelegramChannelId: channel.telegramChannelId,
          nativeClientInstanceId: this.nativeClientInstanceId(assignment.accountKey),
          assignmentId: assignment.id,
        },
        'Channel listener started',
      );
    } catch (error) {
      this.logger.warn(
        {
          account: assignment.accountKey,
          channel: channel.id,
          action: 'diagnostic_listener_registration',
          status: 'failed',
          assignmentId: assignment.id,
          accountId: assignment.accountId,
          channelId: channel.id,
          telegramChannelId: channel.telegramChannelId,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorMessage: errorReason(error),
        },
        'Diagnostic listener registration failed',
      );
      await this.handleListenerError(assignment, channel, error);
      throw error;
    }
  }

  public async stop(assignmentId: number): Promise<void> {
    const listener = this.active.get(assignmentId);
    if (listener === undefined) return;
    this.active.delete(assignmentId);

    try {
      await listener.unsubscribe();
      this.logger.info(
        { account: listener.assignment.accountKey, channel: listener.channel.id, action: 'channel_listener_stop', status: 'stopped' },
        'Channel listener stopped',
      );
    } catch (error) {
      this.logger.error(
        { account: listener.assignment.accountKey, channel: listener.channel.id, action: 'channel_listener_error', status: 'failed', errorReason: errorReason(error) },
        'Channel listener cleanup failed',
      );
    }
  }

  public async stopChannel(channelId: number): Promise<void> {
    await Promise.allSettled(
      [...this.active.values()]
        .filter((listener) => listener.channel.id === channelId)
        .map(async (listener) => this.stop(listener.assignment.id)),
    );
  }

  public async stopAccount(accountKey: string): Promise<void> {
    await Promise.allSettled(
      [...this.active.values()]
        .filter((listener) => listener.assignment.accountKey === accountKey)
        .map(async (listener) => this.stop(listener.assignment.id)),
    );
  }

  public async restartAccount(
    ownerTelegramId: string,
    accountKey: string,
  ): Promise<ListenerStartSummary> {
    await this.stopAccount(accountKey);
    const eligible = this.repository.listEffectiveAssignments(ownerTelegramId)
      .filter(({ assignment }) => assignment.accountKey === accountKey);
    const results = await Promise.allSettled(
      eligible.map(async ({ assignment, channel }) => this.start(assignment, channel)),
    );
    const failed = results.filter((result) => result.status === 'rejected').length;
    const summary = {
      eligible: eligible.length,
      active: eligible.filter(({ assignment }) => this.active.has(assignment.id)).length,
      failed,
    };
    this.logger[failed === 0 ? 'info' : 'warn'](
      {
        account: accountKey,
        action: 'channel_listener_restart_summary',
        status: failed === 0 ? 'ready' : 'partial_failure',
        ...summary,
      },
      'Account channel listeners restarted',
    );
    return summary;
  }

  public async stopAll(): Promise<void> {
    await Promise.allSettled([...this.active.keys()].map(async (id) => this.stop(id)));
  }

  public async shutdown(): Promise<void> {
    this.acceptingMessages = false;
    await this.stopAll();
    const results = await Promise.allSettled([...this.inFlight]);
    const failed = results.filter((result) => result.status === 'rejected').length;
    if (failed > 0) {
      this.logger.error(
        {
          action: 'channel_listener_drain',
          status: 'partial_failure',
          failed,
        },
        'One or more in-flight channel tasks failed during shutdown',
      );
    }
  }

  public isActive(assignmentId: number): boolean {
    return this.active.has(assignmentId);
  }

  /** Read-only process-memory snapshot for diagnostics; it never changes subscriptions. */
  public getDiagnosticSnapshot(): Array<{
    readonly assignmentId: number;
    readonly accountId: number;
    readonly accountKey: string;
    readonly channelId: number;
    readonly expectedTelegramChannelId: string;
    readonly nativeClientInstanceId: string;
    readonly state: 'active';
  }> {
    return [...this.active.values()].map(({ assignment, channel }) => ({
      assignmentId: assignment.id,
      accountId: assignment.accountId,
      accountKey: assignment.accountKey,
      channelId: channel.id,
      expectedTelegramChannelId: channel.telegramChannelId,
      nativeClientInstanceId: this.nativeClientInstanceId(assignment.accountKey),
      state: 'active',
    }));
  }

  private async handleListenerError(
    assignment: ChannelAssignmentRecord,
    channel: ChannelRecord,
    error: unknown,
  ): Promise<void> {
    const listener = this.active.get(assignment.id);
    this.active.delete(assignment.id);
    if (listener !== undefined) {
      try {
        await listener.unsubscribe();
      } catch (cleanupError) {
        this.logger.error(
          {
            account: assignment.accountKey,
            channel: channel.id,
            action: 'channel_listener_cleanup_error',
            status: 'failed',
            errorReason: errorReason(cleanupError),
          },
          'Failed listener subscription was not removed cleanly',
        );
      }
    }
    const reason = errorReason(error);
    const isAccessError = /CHANNEL_PRIVATE|CHAT_ADMIN_REQUIRED|AUTH_KEY_UNREGISTERED|forbidden|access/i.test(reason);
    this.repository.setAssignmentStatus(assignment.id, 'error');
    this.logger.error(
      { account: assignment.accountKey, channel: channel.id, action: isAccessError ? 'channel_access_lost' : 'channel_listener_error', status: 'error', errorReason: reason },
      isAccessError ? 'Telegram channel access was lost' : 'Channel listener failed',
    );
  }

  private track(operation: () => Promise<void>): Promise<void> {
    const task = Promise.resolve().then(operation);
    this.inFlight.add(task);
    return task.finally(() => {
      this.inFlight.delete(task);
    });
  }

  private nativeClientInstanceId(accountKey: string): string {
    return this.gateway.getNativeClientInstanceId?.(accountKey) ?? 'unavailable';
  }
}

function listenerIneligibilityReason(
  assignment: ChannelAssignmentRecord,
  channel: ChannelRecord,
  accountEnabled: boolean,
  acceptingMessages = true,
  alreadyActive = false,
): string {
  if (!acceptingMessages) return 'listener_service_not_accepting_messages';
  if (alreadyActive) return 'assignment_listener_already_active';
  if (!assignment.enabled) return 'assignment_disabled';
  if (!channel.enabled) return 'channel_disabled';
  if (channel.automationBlocked === true) return 'channel_automation_blocked';
  if (!accountEnabled) return 'account_disabled';
  return 'unknown_listener_ineligibility';
}
