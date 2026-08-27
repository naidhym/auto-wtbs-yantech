/**
 * Bulk Channel Manager
 *
 * Orchestrates the bulk channel addition workflow:
 * 1. Parse input (various formats)
 * 2. Deduplicate within batch
 * 3. Resolve each channel (get title, check access)
 * 4. Check for existing channels in DB
 * 5. Create new channel records
 * 6. Assign to selected accounts
 * 7. Start channel sync
 */

import type { AppLogger } from '../logging/logger.js';
import type { TelegramClientAdapter } from '../user-client/gramjs-client.service.js';
import type { ChannelRepository } from './channel.repository.js';
import type { ChannelService } from './channel.service.js';
import { parseChannelInputBatch, deduplicateChannelInputs } from '../shared/bulk-channel-parser.js';
import { toCanonicalChannelId } from '../shared/telegram-channel-id.js';

export interface BulkChannelResolutionResult {
  valid: Array<{
    normalized: string;
    title: string;
    username?: string;
    canonicalId: string;
  }>;
  invalid: Array<{
    normalized: string;
    reason: string;
  }>;
  duplicates: Array<{
    normalized: string;
    existingChannelId: number;
    existingTitle: string;
  }>;
}

export interface BulkChannelCreationResult {
  created: Array<{
    id: number;
    telegramChannelId: string;
    title: string;
  }>;
  skipped: string[];
}

export interface BulkChannelAssignmentResult {
  assignments: Array<{
    accountId: number;
    channelId: number;
  }>;
  failedAssignments: Array<{
    accountId: number;
    channelId: number;
    reason: string;
  }>;
}

export class BulkChannelManager {
  constructor(
    private readonly channelRepository: ChannelRepository,
    private readonly channelService: ChannelService,
    private readonly logger: AppLogger,
  ) {}

  /**
   * Parse and validate channel inputs
   */
  parseInputs(lines: string[]): BulkChannelResolutionResult {
    const parseResult = parseChannelInputBatch(lines);
    const deduplicated = deduplicateChannelInputs(parseResult.valid);

    return {
      valid: deduplicated.map((input) => {
        const validItem: {
          normalized: string;
          title: string;
          username?: string;
          canonicalId: string;
        } = {
          normalized: input.normalized,
          title: '', // Will be filled during resolution
          canonicalId: '',
        };
        if (input.type === 'username') {
          validItem.username = input.normalized;
        }
        return validItem;
      }),
      invalid: parseResult.invalid.map((inv) => ({
        normalized: inv.original,
        reason: inv.reason,
      })),
      duplicates: [],
    };
  }

  /**
   * Resolve channels with Telegram (get titles, verify access)
   * This requires an authenticated client
   */
  async resolveChannels(
    accountKey: string,
    client: TelegramClientAdapter,
    parsedInputs: BulkChannelResolutionResult,
  ): Promise<BulkChannelResolutionResult> {
    const resolved = await Promise.all(
      parsedInputs.valid.map(async (input) => {
        try {
          const entity = await client.resolveChannel(input.normalized);

          const canonicalId = toCanonicalChannelId(String(entity.telegramChannelId));

          // Check if already exists in DB
          const existing = this.channelRepository.getByTelegramId(
            canonicalId,
          );

          if (existing) {
            return {
              type: 'duplicate' as const,
              normalized: input.normalized,
              existingChannelId: existing.id,
              existingTitle: existing.title,
            };
          }

          return {
            type: 'valid' as const,
            normalized: input.normalized,
            title: entity.title,
            username: entity.username,
            canonicalId,
          };
        } catch (error) {
          const reason =
            error instanceof Error ? error.message : 'Unknown error';
          return {
            type: 'invalid' as const,
            normalized: input.normalized,
            reason: `Failed to resolve: ${reason}`,
          };
        }
      }),
    );

    const result: BulkChannelResolutionResult = {
      valid: [],
      invalid: parsedInputs.invalid.map((inv) => ({
        normalized: inv.normalized,
        reason: inv.reason,
      })),
      duplicates: [],
    };

    for (const item of resolved) {
      if (item.type === 'valid') {
        const validItem: {
          normalized: string;
          title: string;
          username?: string;
          canonicalId: string;
        } = {
          normalized: item.normalized,
          title: item.title,
          canonicalId: item.canonicalId,
        };
        if (item.username) {
          validItem.username = item.username;
        }
        result.valid.push(validItem);
      } else if (item.type === 'invalid') {
        result.invalid.push({
          normalized: item.normalized,
          reason: item.reason,
        });
      } else if (item.type === 'duplicate') {
        result.duplicates.push({
          normalized: item.normalized,
          existingChannelId: item.existingChannelId,
          existingTitle: item.existingTitle,
        });
      }
    }

    this.logger.info(
      {
        action: 'bulk_channel_resolution',
        accountKey,
        validCount: result.valid.length,
        invalidCount: result.invalid.length,
        duplicateCount: result.duplicates.length,
      },
      'Bulk channel resolution complete',
    );

    return result;
  }

  /**
   * Create channel records for valid resolved channels
   */
  createChannels(
    channels: Array<{
      telegramChannelId: string;
      title: string;
      username?: string;
    }>,
  ): BulkChannelCreationResult {
    const created: BulkChannelCreationResult['created'] = [];
    const skipped: string[] = [];

    for (const channel of channels) {
      try {
        const createData: {
          telegramChannelId: string;
          title: string;
          username?: string;
        } = {
          telegramChannelId: channel.telegramChannelId,
          title: channel.title,
        };
        if (channel.username) {
          createData.username = channel.username;
        }

        const record = this.channelService.createChannel(createData);

        created.push({
          id: record.id,
          telegramChannelId: record.telegramChannelId,
          title: record.title,
        });

        this.logger.debug(
          {
            action: 'bulk_channel_create',
            channelId: record.id,
            telegramChannelId: channel.telegramChannelId,
          },
          'Channel created',
        );
      } catch (error) {
        skipped.push(channel.telegramChannelId);
        this.logger.warn(
          {
            action: 'bulk_channel_create_failed',
            telegramChannelId: channel.telegramChannelId,
            reason: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to create channel',
        );
      }
    }

    return { created, skipped };
  }

  /**
   * Assign created channels to selected accounts
   */
  async assignToAccounts(
    channelIds: number[],
    accountIds: number[],
  ): Promise<BulkChannelAssignmentResult> {
    const assignments: BulkChannelAssignmentResult['assignments'] = [];
    const failedAssignments: BulkChannelAssignmentResult['failedAssignments'] = [];

    for (const channelId of channelIds) {
      for (const accountId of accountIds) {
        try {
          await this.channelService.assignChannelToAccount(channelId, accountId);
          assignments.push({ accountId, channelId });

          this.logger.debug(
            {
              action: 'bulk_channel_assign',
              channelId,
              accountId,
            },
            'Channel assigned to account',
          );
        } catch (error) {
          failedAssignments.push({
            accountId,
            channelId,
            reason: error instanceof Error ? error.message : 'Unknown error',
          });

          this.logger.warn(
            {
              action: 'bulk_channel_assign_failed',
              channelId,
              accountId,
              reason: error instanceof Error ? error.message : 'Unknown error',
            },
            'Failed to assign channel to account',
          );
        }
      }
    }

    return { assignments, failedAssignments };
  }
}
