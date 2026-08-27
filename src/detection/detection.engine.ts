import type { TelegramSenderDisplayName } from '../rules/rule.types.js';
import type { DetectionResult } from './detection-result.js';

/**
 * Detection Engine
 *
 * Evaluates a normalized ChannelPostReceived against global detection rules.
 *
 * Input: ChannelPostReceived (normalized, no GramJS objects)
 * Output: DetectionResult (MATCH | BLOCK | IGNORE)
 *
 * Rules checked in order:
 * 1. Exclude keywords (if ANY match → BLOCK)
 * 2. Sender display-name patterns (if ANY match → BLOCK)
 * 3. Trigger keywords (if ANY match → MATCH, else IGNORE)
 */

export interface GlobalDetectionConfig {
  readonly enabled: boolean;
  readonly triggerKeywords: readonly string[];
  readonly excludeKeywords: readonly string[];
  readonly cleanupPatterns: readonly string[];
}

export interface DetectionEngineInput {
  readonly text: string;
  readonly senderDisplayName?: string;
  readonly senderDisplayNames?: readonly TelegramSenderDisplayName[];
}

export class DetectionEngine {
  public evaluate(
    input: DetectionEngineInput,
    config: GlobalDetectionConfig,
  ): DetectionResult {
    if (!config.enabled) {
      return {
        status: 'IGNORE',
        reason: 'no_trigger_match',
        matchedTriggers: [],
        matchedExcludeKeywords: [],
        matchedSenderPatterns: [],
      };
    }

    const normalizedText = normalizeText(input.text);
    const senderDisplayNames = input.senderDisplayNames ?? (
      input.senderDisplayName === undefined
        ? []
        : [{ source: 'channel_title_fallback' as const, value: input.senderDisplayName }]
    );

    // 1. Check EXCLUDE keywords
    const matchedExclude = findFirstMatch(normalizedText, config.excludeKeywords);
    if (matchedExclude !== undefined) {
      return {
        status: 'BLOCK',
        reason: 'exclude_match',
        matchedTriggers: [],
        matchedExcludeKeywords: [matchedExclude],
        matchedSenderPatterns: [],
      };
    }

    // 2. Check SENDER PATTERNS (display name cleanup)
    const senderPatternMatch = findFirstSenderPatternMatch(senderDisplayNames, config.cleanupPatterns);
    if (senderPatternMatch !== undefined) {
      return {
        status: 'BLOCK',
        reason: 'sender_pattern_match',
        matchedTriggers: [],
        matchedExcludeKeywords: [],
        matchedSenderPatterns: [senderPatternMatch],
      };
    }

    // 3. Check TRIGGER keywords
    const allMatchedTriggers = findAllMatches(normalizedText, config.triggerKeywords);
    if (allMatchedTriggers.length === 0) {
      return {
        status: 'IGNORE',
        reason: 'no_trigger_match',
        matchedTriggers: [],
        matchedExcludeKeywords: [],
        matchedSenderPatterns: [],
      };
    }

    return {
      status: 'MATCH',
      reason: 'trigger_match',
      matchedTriggers: allMatchedTriggers,
      matchedExcludeKeywords: [],
      matchedSenderPatterns: [],
    };
  }
}

/**
 * Normalize text for matching.
 *
 * - Unicode normalization (NFKC)
 * - Case-insensitive (Indonesian locale)
 * - Remove non-alphanumeric
 * - Collapse whitespace
 */
export function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('id-ID')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Find first matching keyword (case-insensitive, normalized).
 */
export function findFirstMatch(
  normalizedHaystack: string,
  patterns: readonly string[],
): string | undefined {
  return patterns.find((pattern) => {
    const normalized = normalizeText(pattern);
    return normalized.length > 0 && normalizedHaystack.includes(normalized);
  });
}

/**
 * Find all matching keywords (case-insensitive, normalized).
 * Preserves order of original patterns array.
 */
export function findAllMatches(
  normalizedHaystack: string,
  patterns: readonly string[],
): string[] {
  return patterns.filter((pattern) => {
    const normalized = normalizeText(pattern);
    return normalized.length > 0 && normalizedHaystack.includes(normalized);
  });
}

/**
 * Find first sender display-name pattern match.
 * Matches against normalized display names.
 */
export function findFirstSenderPatternMatch(
  senderDisplayNames: readonly TelegramSenderDisplayName[],
  patterns: readonly string[],
): string | undefined {
  for (const sender of senderDisplayNames) {
    const normalizedSender = normalizeText(sender.value);
    const match = findFirstMatch(normalizedSender, patterns);
    if (match !== undefined) return match;
  }
  return undefined;
}
