/**
 * Canonical Telegram Channel ID Helper
 *
 * Normalizes all Telegram channel ID formats to a single canonical representation.
 * This ensures consistent lookups and comparisons throughout the system.
 *
 * Formats handled:
 * - Positive integer: 1611324665 → "1611324665"
 * - Negative integer: -1611324665 → "1611324665"
 * - Supergroup format: -1001611324665 → "1611324665"
 * - String versions of any above
 *
 * Canonical form: positive integer as string
 */

export function toCanonicalChannelId(input: string | number): string {
  let numValue: number;

  if (typeof input === 'string') {
    const parsed = parseInt(input, 10);
    if (isNaN(parsed)) {
      throw new Error(`Invalid channel ID format: ${input}`);
    }
    numValue = parsed;
  } else {
    numValue = input;
  }

  // Normalize to positive
  let absValue = Math.abs(numValue);
  
  // If the absolute value is >= 1000000000, it's in supergroup format (-100XXXXXXXXXX)
  // The -100 prefix means we need to extract the actual ID
  // -1001611324665 → abs = 1001611324665 → remove leading "100" → 1611324665
  if (absValue >= 1000000000) {
    const str = String(absValue);
    // Check if it starts with "100"
    if (str.startsWith('100')) {
      absValue = parseInt(str.substring(3), 10);
    }
  }
  
  return String(absValue);
}

export function isSupergroupId(telegramId: string): boolean {
  const num = parseInt(telegramId, 10);
  return num < -1000000000;
}

export function toPeerFormat(canonicalId: string): string {
  // Convert canonical positive ID to Telegram's -100XXXXXXXXXXX format
  // 1611324665 → -1001611324665
  // This is string concatenation: "-100" + canonical_id
  return `-100${canonicalId}`;
}
