import type { ChannelRepository } from '../channels/channel.repository.js';
import type { ChannelRecord } from '../channels/channel.types.js';
import type { AppLogger } from '../logging/logger.js';
import type { TelegramIncomingMessage } from '../rules/rule.types.js';
import type { DispatchJob } from './dispatch-job.js';
import type { DetectionResult } from './detection-result.js';

export interface DispatchPlannerInput {
  readonly detection: DetectionResult;
  readonly source: TelegramIncomingMessage;
  readonly channel: ChannelRecord;
  readonly automationEnabled: boolean;
  readonly ownerTelegramId: string;
}

/**
 * Dispatch Planner
 *
 * Consumes only MATCH detection results.
 * Finds ALL eligible assigned accounts for the channel.
 * Creates ONE DispatchJob per eligible account.
 *
 * Eligibility:
 * - Account enabled
 * - Account connected/available
 * - Channel assignment exists and is enabled
 * - Assignment status is active (not pending/error/disconnected)
 * - Global automation not paused
 *
 * Deduplication:
 * - Per-account (accountId, sourceMessageId) key
 * - Multiple accounts → multiple jobs (no suppression)
 * - Multiple triggers → one job per account (triggers preserved)
 */

export class DispatchPlanner {
  public constructor(
    private readonly channels: ChannelRepository,
    private readonly logger: AppLogger,
  ) {}

  public plan(input: DispatchPlannerInput): DispatchJob[] {
    if (input.detection.status !== 'MATCH') {
      // Only MATCH results produce executable jobs
      return [];
    }

    if (!input.automationEnabled) {
      // Global automation paused → zero executable jobs
      this.logger.debug(
        {
          channel: input.channel.id,
          telegramChannelId: input.channel.telegramChannelId,
          action: 'dispatch_plan_paused',
          reason: 'global_automation_disabled',
          sourceMessageId: input.source.sourceMessageId,
        },
        'Dispatch planning skipped: global automation paused',
      );
      return [];
    }

    // Find all eligible accounts for this channel
    const eligibleAssignments = this.channels.listEffectiveAssignmentsForChannel(
      input.ownerTelegramId,
      input.channel.id,
    );

    if (eligibleAssignments.length === 0) {
      this.logger.debug(
        {
          channel: input.channel.id,
          telegramChannelId: input.channel.telegramChannelId,
          action: 'dispatch_plan_no_assignments',
          reason: 'no_eligible_assignments',
          sourceMessageId: input.source.sourceMessageId,
        },
        'No eligible assignments found for dispatch planning',
      );
      return [];
    }

    // Create ONE job per eligible account
    const jobs: DispatchJob[] = eligibleAssignments.map((ea) => ({
      accountId: ea.assignment.accountId,
      channelId: input.channel.id,
      sourceMessageId: input.source.sourceMessageId ?? 0,
      matchedTriggers: [...input.detection.matchedTriggers],
      sourceText: input.source.text,
      senderDisplayName: input.source.senderDisplayName ?? '',
      timestamp: new Date(),
    }));

    this.logger.info(
      {
        channel: input.channel.id,
        telegramChannelId: input.channel.telegramChannelId,
        action: 'dispatch_plan_created',
        status: 'planned',
        jobCount: jobs.length,
        sourceMessageId: input.source.sourceMessageId,
        matchedTriggers: input.detection.matchedTriggers,
        accountIds: jobs.map((j) => j.accountId),
      },
      `Dispatch planner created ${jobs.length} jobs for ${eligibleAssignments.length} eligible accounts`,
    );

    return jobs;
  }
}
