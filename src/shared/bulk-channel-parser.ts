/**
 * Bulk Channel Input Parser
 *
 * Parses various channel identifier formats and normalizes them.
 * Supports:
 * - @username
 * - t.me/username
 * - t.me/+... (private links)
 * - Numeric channel IDs (positive or negative)
 */

import { toCanonicalChannelId } from './telegram-channel-id.js';

export interface ParsedChannelInput {
  original: string;
  normalized: string;
  type: 'username' | 'numeric_id' | 'private_link';
}

export interface ChannelInputParseResult {
  valid: ParsedChannelInput[];
  invalid: Array<{ original: string; reason: string }>;
}

export function parseChannelInputBatch(lines: string[]): ChannelInputParseResult {
  const valid: ParsedChannelInput[] = [];
  const invalid: Array<{ original: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) {
      continue;
    }

    // Skip comments
    if (trimmed.startsWith('#')) {
      continue;
    }

    try {
      const parsed = parseSingleChannelInput(trimmed);

      // Check for duplicates within batch
      if (seen.has(parsed.normalized)) {
        invalid.push({
          original: trimmed,
          reason: 'Duplicate in batch',
        });
        continue;
      }

      seen.add(parsed.normalized);
      valid.push(parsed);
    } catch (error) {
      invalid.push({
        original: trimmed,
        reason: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return { valid, invalid };
}

function parseSingleChannelInput(input: string): ParsedChannelInput {
  const trimmed = input.trim();

  // Try numeric format first
  if (/^-?\d+$/.test(trimmed)) {
    try {
      const canonical = toCanonicalChannelId(trimmed);
      return {
        original: trimmed,
        normalized: canonical,
        type: 'numeric_id',
      };
    } catch (error) {
      throw new Error('Invalid numeric channel ID', {
        cause: error,
      });
    }
  }

  // Try @username format
  if (trimmed.startsWith('@')) {
    const username = trimmed.slice(1).toLowerCase();
    if (!/^[a-z0-9_]{5,32}$/.test(username)) {
      throw new Error(
        'Invalid username format (must be 5-32 alphanumeric/underscore)',
      );
    }
    return {
      original: trimmed,
      normalized: username,
      type: 'username',
    };
  }

  // Try t.me/username format
  if (trimmed.startsWith('https://t.me/') || trimmed.startsWith('t.me/')) {
    const url = trimmed.startsWith('https://') ? trimmed : `https://${trimmed}`;
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;

      if (pathname === '/') {
        throw new Error('Invalid t.me URL');
      }

      const parts = pathname.slice(1).split('/');
      const identifier = parts[0];

      if (!identifier) {
        throw new Error('Invalid t.me URL');
      }

      // Handle private link format: t.me/+XXXX
      if (identifier.startsWith('+')) {
        return {
          original: trimmed,
          normalized: identifier,
          type: 'private_link',
        };
      }

      // Handle username
      const username = identifier.toLowerCase();
      if (!/^[a-z0-9_]{5,32}$/.test(username)) {
        throw new Error(
          'Invalid username format (must be 5-32 alphanumeric/underscore)',
        );
      }

      return {
        original: trimmed,
        normalized: username,
        type: 'username',
      };
    } catch (error) {
      throw new Error(
        error instanceof Error ? error.message : 'Invalid t.me URL',
        {
          cause: error,
        },
      );
    }
  }

  throw new Error(
    'Unrecognized format. Use: @username, t.me/username, t.me/+link, or numeric ID',
  );
}

export function deduplicateChannelInputs(
  inputs: ParsedChannelInput[],
): ParsedChannelInput[] {
  const seen = new Set<string>();
  const result: ParsedChannelInput[] = [];

  for (const input of inputs) {
    if (!seen.has(input.normalized)) {
      seen.add(input.normalized);
      result.push(input);
    }
  }

  return result;
}
