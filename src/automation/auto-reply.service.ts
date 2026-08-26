import type { ChannelMessageProcessor, ChannelRecord } from '../channels/channel.types.js';
import { ChannelRepository } from '../channels/channel.repository.js';
import { EventLogRepository } from '../logging/event-log.repository.js';
import { errorReason, type AppLogger } from '../logging/logger.js';
import { DetectionPipelineService } from '../rules/detection-pipeline.service.js';
import { ReplyTemplateService } from '../rules/reply-template.service.js';
import { RuleRepository } from '../rules/rule.repository.js';
import type { ReplyTemplateRecord } from '../rules/rule.types.js';
import { createTelegramMessageLink } from '../user-client/gramjs-client.service.js';
import { AccountAutomationSettingsService } from './account-automation-settings.service.js';
import {
  AutomationDispatchRepository,
  type DispatchClaim,
} from './automation-dispatch.repository.js';
import { AutomationSafetyService } from './automation-safety.service.js';
import type {
  AccountNotification,
  AccountNotificationGateway,
  AccountAutomationSettings,
  AutoReplyGateway,
  DelayScheduler,
  OwnerNotificationGateway,
  ReactionStatus,
  SentReply,
} from './automation.types.js';

const defaultScheduler: DelayScheduler = {
  wait(milliseconds, signal): Promise<void> {
    if (milliseconds === 0) return Promise.resolve();
    return new Promise((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, milliseconds);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  },
};

interface SelectedDispatch {
  readonly settings: AccountAutomationSettings;
  readonly template: ReplyTemplateRecord;
}

export class AutoReplyService implements ChannelMessageProcessor {
  private readonly accountQueues = new Map<string, Promise<void>>();
  private readonly shutdownController = new AbortController();
  private stopping = false;

  public constructor(
    private readonly detection: DetectionPipelineService,
    private readonly safety: AutomationSafetyService,
    private readonly channels: ChannelRepository,
    private readonly rules: RuleRepository,
    private readonly templates: ReplyTemplateService,
    private readonly settings: AccountAutomationSettingsService,
    private readonly dispatches: AutomationDispatchRepository,
    private readonly telegram: AutoReplyGateway,
    private readonly notifications: AccountNotificationGateway,
    private readonly safetyNotifications: OwnerNotificationGateway,
    private readonly eventLogs: EventLogRepository,
    private readonly ownerTelegramId: string,
    private readonly logger: AppLogger,
    private readonly scheduler: DelayScheduler = defaultScheduler,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async process(input: Parameters<ChannelMessageProcessor['process']>[0]): Promise<void> {
    if (this.stopping) return;
    const result = this.detection.process(input);
    const event = result.globalEvent;
    this.logger.info(
      {
        account: input.assignment.accountKey,
        channel: input.channel.id,
        action: 'diagnostic_dispatch',
        status: event?.type === 'MATCH' ? 'eligible_for_dispatch' : 'not_selected',
        reason: event === undefined ? 'no_global_detection_match' : `global_detection:${event.type.toLowerCase()}`,
        assignmentId: input.assignment.id,
        accountId: input.assignment.accountId,
        channelId: input.channel.id,
        telegramChannelId: input.channel.telegramChannelId,
        nativeClientInstanceId: input.message.nativeClientInstanceId ?? 'unavailable',
        ...(input.message.correlationId === undefined ? {} : { correlationId: input.message.correlationId }),
        ...(input.message.sourceMessageId === undefined ? {} : { sourceMessageId: input.message.sourceMessageId }),
      },
      'Diagnostic dispatch boundary reached',
    );
    if (
      input.message.chatKind !== 'channel_post' ||
      input.message.telegramChannelId !== input.channel.telegramChannelId
    ) return;

    if (event?.type === 'CLEANUP_MATCH') {
      await this.handleCleanup(input, event.matchedCleanup);
      return;
    }
    if (event?.type !== 'MATCH') return;

    const sourceMessageId = input.message.sourceMessageId;
    if (sourceMessageId === undefined || !Number.isSafeInteger(sourceMessageId) || sourceMessageId < 1) {
      await this.notifyFailure(input, 'Source message ID is unavailable', event.matchedTrigger);
      return;
    }

    this.record(
      'detection_matched',
      'matched',
      input.assignment.accountId,
      input.channel.id,
      sourceMessageId,
      { trigger: event.matchedTrigger },
      `trigger_keyword:${event.matchedTrigger}`,
    );

    if (!this.safety.isAutomationEnabled()) {
      this.record(
        'limit_skipped',
        'skipped',
        input.assignment.accountId,
        input.channel.id,
        sourceMessageId,
        { trigger: event.matchedTrigger },
        'global_automation_stopped',
      );
      return;
    }
    if (input.channel.automationBlocked === true) return;

    const candidates = this.collectDispatchCandidates(input.channel.id, sourceMessageId);
    if (candidates.length === 0) {
      this.logger.info(
        {
          account: input.assignment.accountKey,
          channel: input.channel.id,
          action: 'dispatch_no_available_account',
          status: 'skipped',
          sourceMessageId,
          reason: 'no_enabled_connected_assigned_account_with_enabled_template',
        },
        'No available account for auto-reply dispatch',
      );
      await this.notifyFailure(
        input,
        'No connected assigned account with an enabled reply template is available',
        event.matchedTrigger,
      );
      return;
    }

    await Promise.all(candidates.map(async (selected) => {
      const claim = this.dispatches.claim({
        accountId: selected.settings.accountId,
        channelId: input.channel.id,
        templateId: selected.template.id,
        sourceMessageId,
        matchedTrigger: event.matchedTrigger,
        delayMs: selected.settings.replyDelayMs,
      });
      if (claim === undefined) {
        this.logger.info(
          {
            account: selected.settings.accountKey,
            channel: input.channel.id,
            action: 'dispatch_duplicate_skipped',
            status: 'skipped',
            sourceMessageId,
            reason: 'account_source_message_already_claimed',
          },
          'Duplicate source message skipped for account',
        );
        this.record(
          'duplicate_skipped',
          'skipped',
          selected.settings.accountId,
          input.channel.id,
          sourceMessageId,
          { trigger: event.matchedTrigger },
          'account_source_message_already_claimed',
        );
        return;
      }

      this.logger.info(
        {
          account: selected.settings.accountKey,
          channel: input.channel.id,
          action: 'dispatch_selected_account',
          status: 'selected',
          sourceMessageId,
          templateId: selected.template.id,
        },
        'Selected eligible account for auto-reply dispatch',
      );
      this.logger.info(
        {
          account: input.assignment.accountKey,
          channel: input.channel.id,
          action: 'diagnostic_dispatch',
          status: 'selected',
          reason: 'dispatch_claim_created',
          assignmentId: input.assignment.id,
          accountId: input.assignment.accountId,
          channelId: input.channel.id,
          telegramChannelId: input.channel.telegramChannelId,
          sourceMessageId,
          targetAccountId: selected.settings.accountId,
          ...(input.message.correlationId === undefined ? {} : { correlationId: input.message.correlationId }),
        },
        'Diagnostic dispatch account selected',
      );
      this.record(
        'reply_scheduled',
        'scheduled',
        selected.settings.accountId,
        input.channel.id,
        sourceMessageId,
        {
          trigger: event.matchedTrigger,
          template: selected.template.id,
          delayMs: selected.settings.replyDelayMs,
        },
      );
      await this.enqueue(selected.settings.accountKey, async () => {
        await this.executeClaim(input, selected, claim);
      });
    }));
  }

  public async shutdown(): Promise<void> {
    if (!this.stopping) {
      this.stopping = true;
      this.shutdownController.abort();
    }
    await Promise.allSettled([...this.accountQueues.values()]);
  }

  private collectDispatchCandidates(channelId: number, sourceMessageId: number): SelectedDispatch[] {
    const preferredTemplateIds = new Set(
      this.rules.listEnabledByChannel(channelId)
        .flatMap((rule) => rule.replyTemplateId === undefined ? [] : [rule.replyTemplateId]),
    );
    const effectiveAssignments = this.channels.listEffectiveAssignmentsForChannel(
      this.ownerTelegramId,
      channelId,
    );
    const effectiveIds = new Set(effectiveAssignments.map(({ assignment }) => assignment.id));
    const candidates: SelectedDispatch[] = [];

    for (const assignment of this.channels.listAssignmentsForChannel(this.ownerTelegramId, channelId)) {
      if (!assignment.enabled) {
        this.logSkippedAccount(assignment, channelId, sourceMessageId, 'assignment_disabled');
        continue;
      }
      if (!effectiveIds.has(assignment.id)) {
        this.logSkippedAccount(assignment, channelId, sourceMessageId, 'account_or_channel_not_enabled');
        continue;
      }
      if (!this.telegram.isAvailable(assignment.accountKey)) {
        this.logSkippedAccount(assignment, channelId, sourceMessageId, 'telegram_client_not_connected');
        continue;
      }
      const accountTemplates = this.templates.list(assignment.accountKey)
        .filter((template) => template.enabled)
        .sort((left, right) => left.id - right.id);
      const template = accountTemplates.find((item) => preferredTemplateIds.has(item.id))
        ?? accountTemplates.at(0);
      if (template === undefined) {
        this.logSkippedAccount(assignment, channelId, sourceMessageId, 'no_enabled_reply_template');
        continue;
      }
      candidates.push({
        settings: this.settings.get(assignment.accountKey),
        template,
      });
    }
    this.logger.info(
      {
        channel: channelId,
        action: 'dispatch_candidate_accounts',
        status: candidates.length === 0 ? 'none' : 'available',
        sourceMessageId,
        candidates: candidates.map((candidate) => ({
          account: candidate.settings.accountKey,
          templateId: candidate.template.id,
        })),
      },
      'Resolved eligible auto-reply candidates',
    );
    return candidates;
  }

  private logSkippedAccount(
    assignment: Parameters<ChannelMessageProcessor['process']>[0]['assignment'],
    channelId: number,
    sourceMessageId: number,
    reason: string,
  ): void {
    this.logger.info(
      {
        account: assignment.accountKey,
        channel: channelId,
        action: 'dispatch_skipped_account',
        status: 'skipped',
        sourceMessageId,
        assignmentId: assignment.id,
        reason,
      },
      'Account skipped during eligible candidate resolution',
    );
  }

  private async executeClaim(
    input: Parameters<ChannelMessageProcessor['process']>[0],
    selected: SelectedDispatch,
    claim: DispatchClaim,
  ): Promise<void> {
    await this.scheduler.wait(claim.delayMs, this.shutdownController.signal);
    if (this.stopping) {
      this.skipClaim(input, selected, claim, 'limit_skipped', 'application_shutdown');
      return;
    }
    if (!this.dispatches.isScheduled(claim.id)) return;
    if (!this.safety.isAutomationEnabled()) {
      this.skipClaim(input, selected, claim, 'limit_skipped', 'global_automation_stopped');
      return;
    }
    const channel = this.channels.getForOwner(this.ownerTelegramId, claim.channelId);
    if (channel === undefined || channel.automationBlocked === true || !channel.enabled) {
      this.skipClaim(input, selected, claim, 'limit_skipped', 'channel_not_available');
      return;
    }

    const currentSettings = this.settings.get(selected.settings.accountKey);
    const now = this.now();
    const lastSentAt = this.dispatches.latestSentAt(currentSettings.accountId);
    if (
      currentSettings.cooldownMs > 0 &&
      lastSentAt !== undefined &&
      now.getTime() - Date.parse(lastSentAt) < currentSettings.cooldownMs
    ) {
      this.skipClaim(input, selected, claim, 'cooldown_skipped', 'minimum_cooldown_active');
      return;
    }

    const hourlyCount = this.dispatches.countSentSince(
      currentSettings.accountId,
      new Date(now.getTime() - 3_600_000).toISOString(),
    );
    if (currentSettings.hourlyLimit > 0 && hourlyCount >= currentSettings.hourlyLimit) {
      this.skipClaim(input, selected, claim, 'limit_skipped', 'hourly_limit_reached');
      return;
    }
    const dailyCount = this.dispatches.countSentSince(
      currentSettings.accountId,
      new Date(now.getTime() - 86_400_000).toISOString(),
    );
    if (currentSettings.dailyLimit > 0 && dailyCount >= currentSettings.dailyLimit) {
      this.skipClaim(input, selected, claim, 'limit_skipped', 'daily_limit_reached');
      return;
    }

    const sourceChannelIdentifier = channel.username === undefined
      ? channel.telegramChannelId
      : `@${channel.username.replace(/^@/, '')}`;
    let reply: SentReply;
    try {
      reply = await this.telegram.sendComment(
        selected.settings.accountKey,
        sourceChannelIdentifier,
        claim.sourceMessageId,
        selected.template.body,
      );
    } catch (error) {
      const reason = errorReason(error);
      this.dispatches.markFailed(claim.id, reason);
      if (/FLOOD_WAIT|FloodWait/i.test(reason)) {
        this.record(
          'flood_wait',
          'failed',
          selected.settings.accountId,
          input.channel.id,
          claim.sourceMessageId,
          { trigger: claim.matchedTrigger, template: selected.template.id, delayMs: claim.delayMs },
          reason,
          'warn',
        );
      }
      this.record(
        'reply_failed',
        'failed',
        selected.settings.accountId,
        input.channel.id,
        claim.sourceMessageId,
        { trigger: claim.matchedTrigger, template: selected.template.id, delayMs: claim.delayMs },
        reason,
        'error',
      );
      const sourceMessageLink = this.createSourceMessageLink(channel, claim.sourceMessageId);
      await this.notifyAccount(
        selected.settings.accountKey,
        {
          type: 'reply_failed',
          accountNickname: selected.settings.accountNickname,
          channelTitle: input.channel.title,
          reason,
          trigger: claim.matchedTrigger,
          sourceMessageId: claim.sourceMessageId,
          ...(sourceMessageLink === undefined ? {} : { sourceMessageLink }),
        },
        selected.settings.accountId,
        input.channel.id,
        claim.sourceMessageId,
      );
      return;
    }

    this.dispatches.markSent(claim.id, reply.messageId);

    let messageLink: string | undefined;
    try {
      messageLink = await reply.resolveMessageLink();
      this.dispatches.setReplyMessageLink(claim.id, messageLink);
    } catch (error) {
      this.record(
        'reply_link_unavailable',
        'unavailable',
        selected.settings.accountId,
        input.channel.id,
        claim.sourceMessageId,
        {
          replyMessageId: reply.messageId,
          trigger: claim.matchedTrigger,
          template: selected.template.id,
          delayMs: claim.delayMs,
        },
        errorReason(error),
        'warn',
      );
    }

      const reaction = await this.performReaction(
        currentSettings,
        sourceChannelIdentifier,
        claim.sourceMessageId,
        input.channel.id,
        reply,
        claim,
        selected.template.id,
      );

    this.dispatches.setReactionStatus(claim.id, reaction.status, reaction.reason);
    this.record(
      'reply_sent',
      'success',
      selected.settings.accountId,
      input.channel.id,
      claim.sourceMessageId,
      {
        replyMessageId: reply.messageId,
        trigger: claim.matchedTrigger,
        template: selected.template.id,
        delayMs: claim.delayMs,
        reactionStatus: reaction.status,
        linkAvailable: messageLink !== undefined,
      },
    );
    const sourceMessageLink = createTelegramMessageLink({
      ...(channel.username === undefined ? {} : { username: channel.username }),
      privateChannelId: channel.telegramChannelId,
      messageId: claim.sourceMessageId,
    });
    await this.notifyAccount(
      selected.settings.accountKey,
      {
        type: 'reply_sent',
        accountNickname: selected.settings.accountNickname,
          channelTitle: input.channel.title,
          trigger: claim.matchedTrigger,
          sourceMessageId: claim.sourceMessageId,
          sourceMessageLink,
          reactionStatus: reaction.status,
          ...(reaction.reason === undefined ? {} : { reactionReason: reaction.reason }),
      },
      selected.settings.accountId,
      input.channel.id,
      claim.sourceMessageId,
      reply.messageId,
    );
  }

  private async performReaction(
    settings: AccountAutomationSettings,
    sourceChannelIdentifier: string,
    sourceMessageId: number,
    channelId: number,
    reply: SentReply,
    claim: DispatchClaim,
    templateId: number,
  ): Promise<{ readonly status: ReactionStatus; readonly reason?: string }> {
    if (!settings.autoReaction) {
      this.record(
        'reaction_skipped',
        'skipped',
        settings.accountId,
        channelId,
        sourceMessageId,
        {
          replyMessageId: reply.messageId,
          trigger: claim.matchedTrigger,
          template: templateId,
          delayMs: claim.delayMs,
        },
        'auto_reaction_disabled',
      );
      return { status: 'skipped', reason: 'auto_reaction_disabled' };
    }
     try {
       const result = await this.telegram.reactToSourceMessage(settings.accountKey, {
         channelIdentifier: sourceChannelIdentifier,
         replyMessageId: reply.messageId,
       });
      if (result.status === 'skipped') {
        const reason = result.reason ?? 'heart_reaction_unavailable';
        this.record(
          'reaction_skipped',
          'skipped',
          settings.accountId,
          channelId,
          sourceMessageId,
          {
            replyMessageId: reply.messageId,
            trigger: claim.matchedTrigger,
            template: templateId,
            delayMs: claim.delayMs,
          },
          reason,
          'warn',
        );
        return { status: 'skipped', reason };
      }
      this.record(
        'reaction_sent',
        'sent',
        settings.accountId,
        channelId,
        sourceMessageId,
        {
          replyMessageId: reply.messageId,
          trigger: claim.matchedTrigger,
          template: templateId,
          delayMs: claim.delayMs,
        },
      );
      return { status: 'sent' };
    } catch (error) {
      const reason = errorReason(error);
      const unsupported = /CHAT_REACTIONS_NONE|REACTION_INVALID|REACTION_EMPTY|not supported|unsupported/i
        .test(reason);
      this.record(
        unsupported ? 'reaction_skipped' : 'reaction_failed',
        unsupported ? 'skipped' : 'failed',
        settings.accountId,
        channelId,
        sourceMessageId,
        {
          replyMessageId: reply.messageId,
          trigger: claim.matchedTrigger,
          template: templateId,
          delayMs: claim.delayMs,
        },
        reason,
        unsupported ? 'warn' : 'error',
      );
      return { status: unsupported ? 'skipped' : 'failed', reason };
    }
  }

  private async handleCleanup(
    input: Parameters<ChannelMessageProcessor['process']>[0],
    pattern: string,
  ): Promise<void> {
    const sourceMessageId = input.message.sourceMessageId;
    const newlyBlocked = await this.safety.blockChannel(
      input.channel.id,
      `cleanup_sender_pattern:${pattern}`,
    );
    if (!newlyBlocked) return;
    this.record(
      'cleanup_detected',
      'detected',
      input.assignment.accountId,
      input.channel.id,
      sourceMessageId,
      { cleanupPattern: pattern },
      `cleanup_sender_pattern:${pattern}`,
      'warn',
    );
    this.record(
      'channel_blocked',
      'blocked',
      input.assignment.accountId,
      input.channel.id,
      sourceMessageId,
      { cleanupPattern: pattern },
      'cleanup_safety_stop_all_channel_assignments',
      'warn',
    );
    await this.notifySafety({
      type: 'cleanup_blocked',
      channelTitle: input.channel.title,
      pattern,
    }, input.assignment.accountId, input.channel.id, sourceMessageId);
  }

  private skipClaim(
    input: Parameters<ChannelMessageProcessor['process']>[0],
    selected: SelectedDispatch,
    claim: DispatchClaim,
    eventType: 'cooldown_skipped' | 'limit_skipped',
    reason: string,
  ): void {
    this.dispatches.markSkipped(claim.id, eventType, reason);
    this.record(
      eventType,
      'skipped',
      selected.settings.accountId,
      input.channel.id,
      claim.sourceMessageId,
      {
        trigger: claim.matchedTrigger,
        template: selected.template.id,
        delayMs: claim.delayMs,
      },
      reason,
      'warn',
    );
  }

  private async notifyFailure(
    input: Parameters<ChannelMessageProcessor['process']>[0],
    reason: string,
    trigger?: string,
  ): Promise<void> {
    const sourceMessageLink = input.message.sourceMessageId === undefined
      ? undefined
      : this.createSourceMessageLink(input.channel, input.message.sourceMessageId);
    this.record(
      'reply_failed',
      'failed',
      input.assignment.accountId,
      input.channel.id,
      input.message.sourceMessageId,
      {},
      reason,
      'error',
    );
    await this.notifyAccount(
      input.assignment.accountKey,
      {
        type: 'reply_failed',
          accountNickname: input.assignment.accountNickname,
          channelTitle: input.channel.title,
          reason,
          ...(trigger === undefined ? {} : { trigger }),
          ...(input.message.sourceMessageId === undefined ? {} : { sourceMessageId: input.message.sourceMessageId }),
          ...(sourceMessageLink === undefined ? {} : { sourceMessageLink }),
      },
      input.assignment.accountId,
      input.channel.id,
      input.message.sourceMessageId,
    );
  }

  private async notifyAccount(
    accountKey: string,
    notification: AccountNotification,
    accountId: number,
    channelId: number,
    sourceMessageId?: number,
    replyMessageId?: number,
  ): Promise<void> {
    let notified = false;
    let reason: string | undefined;
    try {
      notified = await this.notifications.notify(accountKey, notification);
      if (!notified) reason = 'telegram_account_notification_unavailable';
    } catch (error) {
      reason = errorReason(error);
    }
    this.record(
      'account_notified',
      notified ? 'sent' : 'failed',
      accountId,
      channelId,
      sourceMessageId,
      {
        notificationType: notification.type,
        ...(replyMessageId === undefined ? {} : { replyMessageId }),
      },
      reason,
      notified ? 'info' : 'warn',
    );
  }

  private createSourceMessageLink(channel: ChannelRecord, sourceMessageId: number): string | undefined {
    try {
      return createTelegramMessageLink({
        ...(channel.username === undefined ? {} : { username: channel.username }),
        privateChannelId: channel.telegramChannelId,
        messageId: sourceMessageId,
      });
    } catch {
      return undefined;
    }
  }

  private async notifySafety(
    notification: Parameters<OwnerNotificationGateway['notify']>[0],
    accountId: number,
    channelId: number,
    sourceMessageId?: number,
  ): Promise<void> {
    let notified = false;
    let reason: string | undefined;
    try {
      notified = await this.safetyNotifications.notify(notification);
      if (!notified) reason = 'admin_bot_safety_notification_unavailable';
    } catch (error) {
      reason = errorReason(error);
    }
    this.record(
      'safety_notified',
      notified ? 'sent' : 'failed',
      accountId,
      channelId,
      sourceMessageId,
      { notificationType: notification.type },
      reason,
      notified ? 'info' : 'warn',
    );
  }

  private record(
    eventType: string,
    status: string,
    accountId: number,
    channelId: number,
    sourceMessageId: number | undefined,
    metadata: Record<string, unknown>,
    reason?: string,
    level: 'debug' | 'info' | 'warn' | 'error' = 'info',
  ): void {
    const completeMetadata = {
      ...(sourceMessageId === undefined ? {} : { sourceMessageId }),
      ...metadata,
    };
    this.eventLogs.record({
      level,
      eventType,
      accountId,
      channelId,
      action: eventType,
      status,
      ...(reason === undefined ? {} : { reason }),
      metadata: completeMetadata,
    });
    this.logger[level](
      {
        account: accountId,
        channel: channelId,
        action: eventType,
        status,
        ...(reason === undefined ? {} : { reason }),
        ...completeMetadata,
      },
      'M5 auto reply event',
    );
  }

  private enqueue(accountKey: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.accountQueues.get(accountKey) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.accountQueues.set(accountKey, settled);
    return result.finally(() => {
      if (this.accountQueues.get(accountKey) === settled) this.accountQueues.delete(accountKey);
    });
  }
}
