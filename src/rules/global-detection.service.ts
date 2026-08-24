import type { ChannelAssignmentRecord, ChannelRecord } from '../channels/channel.types.js';
import { EventLogRepository } from '../logging/event-log.repository.js';
import type { AppLogger } from '../logging/logger.js';
import type { TelegramIncomingMessage, TelegramSenderDisplayName } from './rule.types.js';
import { GlobalKeywordService } from './global-keyword.service.js';

export type GlobalDetectionEvent =
  | { readonly type: 'MATCH'; readonly matchedTrigger: string }
  | { readonly type: 'EXCLUDED'; readonly matchedExclude: string }
  | { readonly type: 'CLEANUP_MATCH'; readonly matchedCleanup: string };

export class GlobalDetectionService {
  public constructor(
    private readonly keywords: GlobalKeywordService,
    private readonly eventLogs: EventLogRepository,
    private readonly logger: AppLogger,
  ) {}

  public process(input: {
    readonly assignment: ChannelAssignmentRecord;
    readonly channel: ChannelRecord;
    readonly message: TelegramIncomingMessage;
  }): GlobalDetectionEvent | undefined {
    const { assignment, channel, message } = input;
    this.logger.info(
      {
        account: assignment.accountKey,
        channel: channel.id,
        action: 'diagnostic_global_detection',
        status: 'entered',
        detected: false,
        reason: 'message_received_from_listener',
        assignmentId: assignment.id,
        accountId: assignment.accountId,
        channelId: channel.id,
        telegramChannelId: channel.telegramChannelId,
        nativeClientInstanceId: message.nativeClientInstanceId ?? 'unavailable',
        ...(message.correlationId === undefined ? {} : { correlationId: message.correlationId }),
        ...(message.sourceMessageId === undefined ? {} : { sourceMessageId: message.sourceMessageId }),
      },
      'Diagnostic global detection boundary entered',
    );
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
        reason,
        undefined,
        undefined,
        undefined,
        message.sourceMessageId,
      );
      this.logDiagnostic(input, false, reason);
      return undefined;
    }

    const configuration = this.keywords.getConfiguration();
    const text = normalizeGlobalMatchText(message.text);
    if (!configuration.enabled) {
      this.logDiagnostic(input, false, 'global_detection_disabled');
      return undefined;
    }

    const senderDisplayNames = message.senderDisplayNames ?? (
      message.senderDisplayName === undefined
        ? []
        : [{ source: 'channel_title_fallback' as const, value: message.senderDisplayName }]
    );
    const cleanupMatch = firstCleanupMatch(senderDisplayNames, configuration.cleanupPatterns);
    const matchedCleanup = cleanupMatch?.pattern;
    if (matchedCleanup !== undefined) {
      this.record(
        'cleanup_match',
        'cleanup_match',
        assignment,
        channel,
        `sender_display_name_pattern:${matchedCleanup}`,
        undefined,
        undefined,
        matchedCleanup,
        message.sourceMessageId,
      );
      this.logDiagnostic(input, false, 'cleanup_match');
      return { type: 'CLEANUP_MATCH', matchedCleanup };
    }

    const matchedExclude = firstMatch(text, configuration.excludeKeywords);
    if (matchedExclude !== undefined) {
      this.record(
        'detection_excluded',
        'excluded',
        assignment,
        channel,
        `exclude_keyword:${matchedExclude}`,
        undefined,
        matchedExclude,
        undefined,
        message.sourceMessageId,
      );
      this.logDiagnostic(input, false, 'excluded');
      return { type: 'EXCLUDED', matchedExclude };
    }

    const matchedTrigger = firstMatch(text, configuration.triggerKeywords);
    if (matchedTrigger === undefined) {
      this.logDiagnostic(input, false, 'no_trigger_match');
      return undefined;
    }
    this.record(
      'detection_match',
      'match',
      assignment,
      channel,
      `trigger_keyword:${matchedTrigger}`,
      matchedTrigger,
      undefined,
      undefined,
      message.sourceMessageId,
    );
    this.logDiagnostic(input, true, 'trigger_match');
    return { type: 'MATCH', matchedTrigger };
  }

  private logDiagnostic(
    input: { readonly assignment: ChannelAssignmentRecord; readonly channel: ChannelRecord; readonly message: TelegramIncomingMessage },
    detected: boolean,
    reason: string,
  ): void {
    this.logger.info(
      {
        account: input.assignment.accountKey,
        channel: input.channel.id,
        action: 'diagnostic_global_detection',
        status: detected ? 'detected' : 'not_detected',
        detected,
        reason,
        assignmentId: input.assignment.id,
        accountId: input.assignment.accountId,
        channelId: input.channel.id,
        telegramChannelId: input.channel.telegramChannelId,
        ...(input.message.sourceMessageId === undefined ? {} : { sourceMessageId: input.message.sourceMessageId }),
        ...(input.message.correlationId === undefined ? {} : { correlationId: input.message.correlationId }),
      },
      'Diagnostic global detection evaluated',
    );
  }

  private record(
    eventType: string,
    status: string,
    assignment: ChannelAssignmentRecord,
    channel: ChannelRecord,
    reason: string,
    matchedTrigger?: string,
    matchedExclude?: string,
    matchedCleanup?: string,
    sourceMessageId?: number,
  ): void {
    this.eventLogs.record({
      level: eventType === 'non_channel_ignored' ? 'debug' : 'info',
      eventType,
      accountId: assignment.accountId,
      channelId: channel.id,
      action: eventType,
      status,
      reason,
      ...(matchedExclude === undefined ? {} : { excludeKeyword: matchedExclude }),
      metadata: {
        ...(sourceMessageId === undefined ? {} : { sourceMessageId }),
        ...(matchedTrigger === undefined ? {} : { matchedTrigger }),
        ...(matchedExclude === undefined ? {} : { matchedExclude }),
        ...(matchedCleanup === undefined ? {} : { matchedCleanup }),
      },
    });
    this.logger[eventType === 'non_channel_ignored' ? 'debug' : 'info'](
      {
        account: assignment.accountKey,
        channel: channel.id,
        action: eventType,
        status,
        reason,
        ...(matchedTrigger === undefined ? {} : { matchedTrigger }),
        ...(matchedExclude === undefined ? {} : { matchedExclude }),
        ...(matchedCleanup === undefined ? {} : { matchedCleanup }),
        ...(sourceMessageId === undefined ? {} : { sourceMessageId }),
      },
      'Global channel keyword detection event',
    );
  }
}

export function normalizeGlobalMatchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('id-ID')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function firstMatch(text: string, keywords: readonly string[]): string | undefined {
  return keywords.find((keyword) => {
    const normalized = normalizeGlobalMatchText(keyword);
    return normalized.length > 0 && text.includes(normalized);
  });
}

function firstCleanupMatch(
  senderDisplayNames: readonly TelegramSenderDisplayName[],
  patterns: readonly string[],
): { readonly pattern: string; readonly source: string } | undefined {
  for (const sender of senderDisplayNames) {
    const matchedPattern = firstMatch(normalizeGlobalMatchText(sender.value), patterns);
    if (matchedPattern !== undefined) return { pattern: matchedPattern, source: sender.source };
  }
  return undefined;
}
