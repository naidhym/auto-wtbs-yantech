import type { ChannelAssignmentRecord, ChannelRecord } from '../channels/channel.types.js';
import { EventLogRepository } from '../logging/event-log.repository.js';
import type { AppLogger } from '../logging/logger.js';
import { RuleRepository } from './rule.repository.js';
import type {
  DetectionEvent,
  RuleRecord,
  TelegramIncomingMessage,
} from './rule.types.js';

export class DetectionService {
  public constructor(
    private readonly rules: RuleRepository,
    private readonly eventLogs: EventLogRepository,
    private readonly logger: AppLogger,
  ) {}

  public process(input: {
    readonly assignment: ChannelAssignmentRecord;
    readonly channel: ChannelRecord;
    readonly message: TelegramIncomingMessage;
  }): DetectionEvent[] {
    const { assignment, channel, message } = input;
    if (
      message.chatKind !== 'channel_post' ||
      message.telegramChannelId !== channel.telegramChannelId
    ) {
      const reason = message.chatKind !== 'channel_post'
        ? `chat_kind:${message.chatKind}`
        : 'channel_identity_mismatch';
      this.record(
        'non_channel_ignored',
        'ignored',
        assignment,
        channel,
        undefined,
        reason,
      );
      return [];
    }

    const text = normalizeMatchText(message.text);
    const sender = normalizeMatchText(message.senderDisplayName ?? '');
    const events: DetectionEvent[] = [];

    for (const rule of this.rules.listEnabledByChannel(channel.id)) {
      const cleanup = firstMatch(sender, rule.cleanupSenderPatterns);
      if (cleanup !== undefined) {
        events.push(this.emit(
          'CLEANUP_MATCH',
          'cleanup_match',
          assignment,
          channel,
          rule,
          'sender_display_name_pattern',
          cleanup,
        ));
        continue;
      }

      const trigger = firstMatch(text, rule.triggerKeywords);
      if (trigger === undefined) continue;
      const excluded = firstMatch(text, rule.excludeKeywords);
      if (excluded !== undefined) {
        events.push(this.emit(
          'EXCLUDED',
          'detection_excluded',
          assignment,
          channel,
          rule,
          `exclude_keyword:${excluded}`,
          excluded,
        ));
        continue;
      }

      events.push(this.emit(
        'MATCH',
        'detection_match',
        assignment,
        channel,
        rule,
        `trigger_keyword:${trigger}`,
        trigger,
      ));
    }
    return events;
  }

  private emit(
    type: DetectionEvent['type'],
    eventType: string,
    assignment: ChannelAssignmentRecord,
    channel: ChannelRecord,
    rule: RuleRecord,
    reason: string,
    matchedValue: string,
  ): DetectionEvent {
    this.record(eventType, type.toLocaleLowerCase('en-US'), assignment, channel, rule, reason,
      eventType === 'detection_excluded' ? matchedValue : undefined);
    return {
      type,
      ruleId: rule.id,
      channelId: channel.id,
      accountKey: assignment.accountKey,
      reason,
      matchedValue,
    };
  }

  private record(
    eventType: string,
    status: string,
    assignment: ChannelAssignmentRecord,
    channel: ChannelRecord,
    rule: RuleRecord | undefined,
    reason: string,
    excludeKeyword?: string,
  ): void {
    this.eventLogs.record({
      level: eventType === 'non_channel_ignored' ? 'debug' : 'info',
      eventType,
      accountId: assignment.accountId,
      channelId: channel.id,
      ...(rule === undefined ? {} : { ruleId: rule.id }),
      action: eventType,
      status,
      reason,
      ...(excludeKeyword === undefined ? {} : { excludeKeyword }),
    });
    this.logger[eventType === 'non_channel_ignored' ? 'debug' : 'info'](
      {
        account: assignment.accountKey,
        channel: channel.id,
        ...(rule === undefined ? {} : { rule: rule.id }),
        action: eventType,
        status,
        reason,
      },
      'Channel detection event',
    );
  }
}

export function normalizeMatchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('id-ID')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function firstMatch(normalizedHaystack: string, patterns: readonly string[]): string | undefined {
  return patterns.find((pattern) => {
    const normalizedPattern = normalizeMatchText(pattern);
    return normalizedPattern.length > 0 && normalizedHaystack.includes(normalizedPattern);
  });
}
