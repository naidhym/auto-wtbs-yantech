/**
 * Normalizes Telegram channel IDs to a canonical positive string representation.
 * 
 * GramJS uses BigInt for channel IDs which can be positive or negative.
 * Native Telegram updates always send positive channel IDs.
 * This helper ensures consistent string representation for registry lookups.
 * 
 * Examples:
 * - 3980589729 → "3980589729"
 * - -1611324665 → "1611324665"
 * - BigInt(3980589729) → "3980589729"
 * - BigInt(-1611324665) → "1611324665"
 */
export function canonicalTelegramChannelId(
  channelId: string | number | bigint | { toString(): string },
): string {
  let idStr: string;

  if (typeof channelId === 'string') {
    idStr = channelId;
  } else if (typeof channelId === 'number' || typeof channelId === 'bigint') {
    idStr = String(channelId);
  } else if (typeof channelId === 'object' && channelId !== null && 'toString' in channelId) {
    // Validate it's a numeric-like object (has toString method that returns numeric string)
    idStr = channelId.toString();
    if (!/^-?\d+$/.test(idStr)) {
      throw new Error(`Invalid channel ID: toString() did not return numeric string: ${idStr}`);
    }
  } else {
    throw new Error(`Invalid channel ID type: ${typeof channelId}`);
  }

  // Validate it's numeric
  if (!/^-?\d+$/.test(idStr)) {
    throw new Error(`Invalid channel ID: not a numeric string: ${idStr}`);
  }

  // Remove leading negative sign if present
  if (idStr.startsWith('-')) {
    return idStr.slice(1);
  }

  return idStr;
}

/**
 * Verifies that two channel ID representations refer to the same channel.
 * Useful for debugging registry mismatches.
 */
export function channelIdsMatch(
  id1: string | number | bigint | { toString(): string },
  id2: string | number | bigint | { toString(): string },
): boolean {
  return canonicalTelegramChannelId(id1) === canonicalTelegramChannelId(id2);
}
