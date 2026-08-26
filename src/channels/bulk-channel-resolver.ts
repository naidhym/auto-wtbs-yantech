import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';

import type { ChannelRecord } from './channel.types.js';
import { ChannelRepository } from './channel.repository.js';
import { resolveBroadcastChannel } from '../user-client/gramjs-client.service.js';
import { canonicalTelegramChannelId } from '../user-client/telegram-channel-id.js';

export interface BulkChannelResolutionValid {
  readonly identifier: string;
  readonly resolvedChannelId: string; // Canonical positive string
  readonly title: string;
  readonly username?: string;
  readonly entity: Api.Channel;
}

export interface BulkChannelResolutionInvalid {
  readonly identifier: string;
  readonly reason: string;
}

export interface BulkChannelResolutionDuplicate {
  readonly identifier: string;
  readonly existingChannelId: string;
  readonly existingTitle: string;
  readonly existingRecord: ChannelRecord;
}

export interface BulkChannelResolutionResult {
  readonly valid: readonly BulkChannelResolutionValid[];
  readonly invalid: readonly BulkChannelResolutionInvalid[];
  readonly duplicates: readonly BulkChannelResolutionDuplicate[];
  readonly summary: {
    readonly total: number;
    readonly validCount: number;
    readonly invalidCount: number;
    readonly duplicateCount: number;
  };
}

export class BulkChannelResolver {
  public constructor(
    private readonly client: TelegramClient,
    private readonly repository: ChannelRepository,
  ) {}

  /**
   * Resolve multiple channel identifiers from a single user message.
   *
   * Input: User message with channels, one per line:
   *   @channelA
   *   https://t.me/channelB
   *   -1001234567890
   *   @channelC
   *
   * Output: Structured result categorizing each identifier
   *
   * Each channel is resolved independently. One failure does not abort the batch.
   * Duplicates are detected against existing DB channels.
   */
  public async resolve(input: string): Promise<BulkChannelResolutionResult> {
    const valid: BulkChannelResolutionValid[] = [];
    const invalid: BulkChannelResolutionInvalid[] = [];
    const duplicates: BulkChannelResolutionDuplicate[] = [];
    const seenResolvedIds = new Set<string>();

    // Parse input: split by newlines, trim, filter empty, deduplicate
    const identifiers = Array.from(
      new Set(
        input
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      ),
    );

    if (identifiers.length === 0) {
      return {
        valid: [],
        invalid: [{ identifier: input, reason: 'No valid identifiers provided' }],
        duplicates: [],
        summary: { total: 0, validCount: 0, invalidCount: 1, duplicateCount: 0 },
      };
    }

    // Process each identifier independently
    for (const identifier of identifiers) {
      try {
        // Attempt resolution
        const entity = await resolveBroadcastChannel(this.client, identifier);

        // Check if already in database
        const canonicalId = canonicalTelegramChannelId(entity.id);

        // Check against batch duplicates (same identifier resolved multiple times)
        if (seenResolvedIds.has(canonicalId)) {
          invalid.push({
            identifier,
            reason: 'Duplicate in batch (already resolved)',
          });
          continue;
        }

        // Check if already in database
        const existing = this.repository.getByTelegramId(canonicalId);

        if (existing !== undefined) {
          // Already exists in DB
          duplicates.push({
            identifier,
            existingChannelId: canonicalId,
            existingTitle: existing.title,
            existingRecord: existing,
          });
        } else {
          // New channel
          seenResolvedIds.add(canonicalId);
          valid.push({
            identifier,
            resolvedChannelId: canonicalId,
            title: entity.title,
            ...(entity.username === undefined ? {} : { username: entity.username }),
            entity,
          });
        }
      } catch (error) {
        // Categorize error
        let reason: string;

        if (error instanceof Error) {
          if (error.message.includes('not a broadcast')) {
            reason = 'Not a broadcast channel';
          } else if (error.message.includes('access')) {
            reason = 'Cannot access channel';
          } else if (error.message.includes('timeout') || error.message.includes('TIMEOUT')) {
            reason = 'Telegram timeout';
          } else if (error.message.includes('Invalid')) {
            reason = 'Invalid identifier format';
          } else {
            reason = error.message;
          }
        } else {
          reason = 'Unknown error';
        }

        invalid.push({
          identifier,
          reason,
        });
      }
    }

    return {
      valid,
      invalid,
      duplicates,
      summary: {
        total: identifiers.length,
        validCount: valid.length,
        invalidCount: invalid.length,
        duplicateCount: duplicates.length,
      },
    };
  }
}
