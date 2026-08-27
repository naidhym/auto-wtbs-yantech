/**
 * Normalized Detection Result
 *
 * Output of detection engine after evaluating a ChannelPostReceived against
 * global trigger/exclude/sender-pattern rules.
 *
 * MATCH: Post qualified for dispatch planning
 * BLOCK: Post explicitly excluded or blocked by pattern
 * IGNORE: Post did not match any trigger
 */

export type DetectionStatus = 'MATCH' | 'BLOCK' | 'IGNORE';

export type DetectionReason =
  | 'trigger_match'
  | 'exclude_match'
  | 'sender_pattern_match'
  | 'no_trigger_match';

export interface DetectionResult {
  readonly status: DetectionStatus;
  readonly reason: DetectionReason;
  readonly matchedTriggers: readonly string[];
  readonly matchedExcludeKeywords: readonly string[];
  readonly matchedSenderPatterns: readonly string[];
}
