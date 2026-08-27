import type { AccountRecord } from '../accounts/account.types.js';
import { AccountService } from '../accounts/account.service.js';
import { errorReason, type AppLogger } from '../logging/logger.js';
import { ChannelListenerService } from './channel-listener.service.js';
import type { ListenerStartSummary } from './channel-listener.service.js';
import { ChannelRepository } from './channel.repository.js';
import type { ChannelAssignmentRecord, ChannelRecord, ResolvedTelegramChannel } from './channel.types.js';
import type { ChannelAccessGateway } from './channel.types.js';

export interface ChannelDetail {
  readonly channel: ChannelRecord;
  readonly assignments: ChannelAssignmentRecord[];
}

export class ChannelService {
  public constructor(
    private readonly repository: ChannelRepository,
    private readonly accounts: AccountService,
    private readonly ownerTelegramId: string,
    private readonly gateway: ChannelAccessGateway,
    private readonly listeners: ChannelListenerService,
    private readonly logger: AppLogger,
  ) {}

  public listChannels(): ChannelRecord[] {
    return this.repository.list(this.ownerTelegramId);
  }

  public listAccounts(): AccountRecord[] {
    return this.accounts.list();
  }

  public getChannel(channelId: number): ChannelDetail {
    const channel = this.repository.getForOwner(this.ownerTelegramId, channelId);
    if (channel === undefined) throw new Error(`Channel not found: ${channelId}`);
    return { channel, assignments: this.repository.listAssignmentsForChannel(this.ownerTelegramId, channelId) };
  }

  public listAccountChannels(accountKey: string) {
    this.accounts.get(accountKey);
    return this.repository.listAssignmentsForAccount(this.ownerTelegramId, accountKey);
  }

  public async addChannel(identifier: string, accountKey: string): Promise<ChannelDetail> {
    const account = this.accounts.get(accountKey);
    this.logger.info({ account: accountKey, action: 'channel_resolve', status: 'started' }, 'Channel validation started');
    try {
      const resolved = await this.gateway.resolve(accountKey, identifier);
      this.logger.info({ account: accountKey, channel: resolved.telegramChannelId, action: 'channel_resolve', status: 'resolved', entityType: resolved.entityType, title: resolved.title }, 'Channel resolved through selected account');
      const existing = this.repository.getByTelegramId(resolved.telegramChannelId);
      const channel = this.repository.saveResolved(resolved);
      if (existing === undefined) {
        this.logger.info({ account: accountKey, channel: channel.id, action: 'channel_create', status: 'created' }, 'Independent channel created');
      }
      if (this.repository.getAssignment(account.id, channel.id) !== undefined) {
        throw new Error(`${account.nickname} already monitors ${channel.title}`);
      }
      const assignment = this.repository.assign(account.id, channel.id);
      this.logger.info({ account: accountKey, channel: channel.id, action: 'channel_assign', status: 'assigned' }, 'Account assigned to channel');
      await this.listeners.start(assignment, channel);
      return this.getChannel(channel.id);
    } catch (error) {
      this.logger.warn({ account: accountKey, action: 'channel_resolve', status: 'failed', errorReason: errorReason(error) }, 'Channel validation or assignment failed');
      throw error;
    }
  }

  public async resolveChannelPreview(
    identifier: string,
    accountKey: string,
  ): Promise<{ resolved: ResolvedTelegramChannel; existing: ChannelRecord | undefined }> {
    const resolved = await this.gateway.resolve(accountKey, identifier);
    const existing = this.repository.getByTelegramId(resolved.telegramChannelId);
    return { resolved, existing };
  }

  public async addBulkChannels(
    identifiers: string[],
    accountKeys: string[],
  ): Promise<{
    created: number[];
    assigned: Array<{ identifier: string; accountKey: string; channelId: number }>;
    failed: Array<{ identifier: string; accountKey: string; reason: string }>;
  }> {
    const created: number[] = [];
    const assigned: Array<{ identifier: string; accountKey: string; channelId: number }> = [];
    const failed: Array<{ identifier: string; accountKey: string; reason: string }> = [];

    for (const accountKey of accountKeys) {
      for (const identifier of identifiers) {
        try {
          const detail = await this.addChannel(identifier, accountKey);
          assigned.push({ identifier, accountKey, channelId: detail.channel.id });
          if (!created.includes(detail.channel.id)) created.push(detail.channel.id);
        } catch (error) {
          failed.push({ identifier, accountKey, reason: error instanceof Error ? error.message : 'Unknown error' });
        }
      }
    }

    return { created, assigned, failed };
  }

  public async assignAccount(channelId: number, accountKey: string): Promise<ChannelDetail> {
    const detail = this.getChannel(channelId);
    const account = this.accounts.get(accountKey);
    if (this.repository.getAssignment(account.id, channelId) !== undefined) {
      throw new Error(`${account.nickname} is already assigned to ${detail.channel.title}`);
    }
    const resolved = await this.gateway.resolve(accountKey, detail.channel.username ?? detail.channel.telegramChannelId);
    if (resolved.telegramChannelId !== detail.channel.telegramChannelId) {
      throw new Error('Resolved Telegram identity does not match the saved channel');
    }
    this.repository.saveResolved(resolved);
    const assignment = this.repository.assign(account.id, channelId);
    this.logger.info({ account: accountKey, channel: channelId, action: 'channel_assign', status: 'assigned' }, 'Account assigned to channel');
    await this.listeners.start(assignment, detail.channel);
    return this.getChannel(channelId);
  }

  public async unassign(assignmentId: number): Promise<void> {
    const assignment = this.requireAssignment(assignmentId);
    await this.listeners.stop(assignment.id);
    this.repository.unassign(assignment.id);
    this.logger.info({ account: assignment.accountKey, channel: assignment.channelId, action: 'channel_unassign', status: 'unassigned' }, 'Account unassigned from channel');
  }

  public async setChannelEnabled(channelId: number, enabled: boolean): Promise<ChannelDetail> {
    this.getChannel(channelId);
    if (!enabled) await this.listeners.stopChannel(channelId);
    this.repository.setChannelEnabled(channelId, enabled);
    this.logger.info({ channel: channelId, action: enabled ? 'channel_enable' : 'channel_disable', status: enabled ? 'enabled' : 'disabled' }, 'Channel enabled state changed');
    const detail = this.getChannel(channelId);
    if (enabled) {
      await this.startAssignments(detail, detail.assignments.filter((item) => item.enabled));
    }
    return detail;
  }

  public async blockAutomation(channelId: number, reason: string): Promise<ChannelDetail> {
    const current = this.getChannel(channelId);
    if (current.channel.automationBlocked === true) return current;
    this.repository.setAutomationBlocked(channelId, true, reason);
    await this.listeners.stopChannel(channelId);
    this.logger.warn(
      { channel: channelId, action: 'channel_blocked', status: 'blocked', reason },
      'Channel automation blocked for all assigned accounts',
    );
    return this.getChannel(channelId);
  }

  public async resumeAutomation(channelId: number): Promise<ChannelDetail> {
    this.getChannel(channelId);
    this.repository.setAutomationBlocked(channelId, false);
    const detail = this.getChannel(channelId);
    if (detail.channel.enabled) {
      await this.startAssignments(
        detail,
        detail.assignments.filter((assignment) => assignment.enabled),
      );
    }
    this.logger.info(
      { channel: channelId, action: 'channel_resumed', status: 'resumed' },
      'Channel automation manually resumed',
    );
    return this.getChannel(channelId);
  }

  public async setAssignmentEnabled(assignmentId: number, enabled: boolean): Promise<ChannelDetail> {
    const assignment = this.requireAssignment(assignmentId);
    if (!enabled) await this.listeners.stop(assignment.id);
    this.repository.setAssignmentEnabled(assignment.id, enabled);
    const detail = this.getChannel(assignment.channelId);
    const updated = detail.assignments.find((item) => item.id === assignment.id);
    if (enabled && updated !== undefined) await this.listeners.start(updated, detail.channel);
    return this.getChannel(assignment.channelId);
  }

  public async removeChannel(channelId: number): Promise<void> {
    this.getChannel(channelId);
    await this.listeners.stopChannel(channelId);
    this.repository.remove(channelId);
    this.logger.info({ channel: channelId, action: 'channel_remove', status: 'removed' }, 'Independent channel removed');
  }

  public async removeBulk(channelIds: readonly number[]): Promise<void> {
    for (const channelId of channelIds) {
      this.getChannel(channelId);
      await this.listeners.stopChannel(channelId);
    }
    this.repository.removeBulk(channelIds);
    this.logger.info(
      { action: 'channel_remove_bulk', status: 'removed', count: channelIds.length },
      `${channelIds.length} channels removed in bulk`,
    );
  }

  public async assignAccountBulk(
    channelIds: readonly number[],
    accountKeys: readonly string[],
  ): Promise<Array<{ channel: ChannelRecord; assignments: ChannelAssignmentRecord[] }>> {
    const accounts = accountKeys.map((key) => this.accounts.get(key));
    const results: Array<{ channel: ChannelRecord; assignments: ChannelAssignmentRecord[] }> = [];

    for (const channelId of channelIds) {
      const detail = this.getChannel(channelId);
      const newAssignments: ChannelAssignmentRecord[] = [];

      for (const account of accounts) {
        if (this.repository.getAssignment(account.id, channelId) === undefined) {
          const assignment = this.repository.assign(account.id, channelId);
          newAssignments.push(assignment);
          this.logger.info(
            { account: account.accountKey, channel: channelId, action: 'channel_assign', status: 'assigned' },
            `Account ${account.label} assigned to channel`,
          );
        }
      }

      if (newAssignments.length > 0) {
        await this.startAssignments(detail, newAssignments);
      }

      results.push({
        channel: detail.channel,
        assignments: this.repository.listAssignmentsForChannel(this.ownerTelegramId, channelId),
      });
    }

    return results;
  }

  public startListeners(): Promise<ListenerStartSummary> {
    return this.listeners.startAll(this.ownerTelegramId);
  }
  public stopListeners(): Promise<void> { return this.listeners.stopAll(); }
  public stopAccountListeners(accountKey: string): Promise<void> { return this.listeners.stopAccount(accountKey); }
  public restartAccountListeners(accountKey: string): Promise<ListenerStartSummary> {
    return this.listeners.restartAccount(this.ownerTelegramId, accountKey);
  }
  public shutdown(): Promise<void> { return this.listeners.shutdown(); }

  /**
   * Create a channel from resolved Telegram entity data
   * Used by bulk channel manager
   */
  public createChannel(data: {
    telegramChannelId: string;
    title: string;
    username?: string;
  }): ChannelRecord {
    const existing = this.repository.getByTelegramId(data.telegramChannelId);
    if (existing !== undefined) {
      throw new Error(`Channel already exists: ${data.title}`);
    }

    const channel = this.repository.create({
      telegramChannelId: data.telegramChannelId,
      username: data.username,
      title: data.title,
    });

    this.logger.info(
      {
        channel: channel.id,
        telegramChannelId: data.telegramChannelId,
        action: 'channel_create',
        status: 'created',
      },
      'Channel created',
    );

    return channel;
  }

  /**
   * Assign existing channel to account
   * Used by bulk channel manager
   */
  public async assignChannelToAccount(
    channelId: number,
    accountId: number,
  ): Promise<ChannelAssignmentRecord> {
    const channel = this.repository.get(channelId);
    if (channel === undefined) {
      throw new Error(`Channel not found: ${channelId}`);
    }

    const account = this.accounts.getById(accountId);
    if (account === undefined) {
      throw new Error(`Account not found: ${accountId}`);
    }

    const existing = this.repository.getAssignment(accountId, channelId);
    if (existing !== undefined) {
      throw new Error(
        `${account.label} is already assigned to ${channel.title}`,
      );
    }

    const assignment = this.repository.assign(accountId, channelId);

    this.logger.info(
      {
        account: account.accountKey,
        channel: channelId,
        action: 'channel_assign',
        status: 'assigned',
      },
      'Account assigned to channel',
    );

    // Start listener for this assignment
    await this.listeners.start(assignment, channel);

    return assignment;
  }

  private requireAssignment(assignmentId: number): ChannelAssignmentRecord {
    const assignment = this.repository.getAssignmentById(this.ownerTelegramId, assignmentId);
    if (assignment === undefined) throw new Error(`Channel assignment not found: ${assignmentId}`);
    return assignment;
  }

  private async startAssignments(
    detail: ChannelDetail,
    assignments: readonly ChannelAssignmentRecord[],
  ): Promise<void> {
    const results = await Promise.allSettled(
      assignments.map(async (assignment) => this.listeners.start(assignment, detail.channel)),
    );
    const failed = results.filter((result) => result.status === 'rejected').length;
    if (failed > 0) {
      this.logger.warn(
        {
          channel: detail.channel.id,
          action: 'channel_listener_start_summary',
          status: 'partial_failure',
          eligible: assignments.length,
          failed,
        },
        'Some channel assignments could not start listeners',
      );
    }
  }
}
