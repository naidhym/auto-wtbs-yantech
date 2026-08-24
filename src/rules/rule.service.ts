import { ChannelRepository } from '../channels/channel.repository.js';
import { EventLogRepository } from '../logging/event-log.repository.js';
import type { AppLogger } from '../logging/logger.js';
import { ReplyTemplateService } from './reply-template.service.js';
import { RuleRepository } from './rule.repository.js';
import type { RuleInput, RuleRecord } from './rule.types.js';

export class RuleService {
  public constructor(
    private readonly repository: RuleRepository,
    private readonly channels: ChannelRepository,
    private readonly templates: ReplyTemplateService,
    private readonly eventLogs: EventLogRepository,
    private readonly ownerTelegramId: string,
    private readonly logger: AppLogger,
  ) {}

  public list(): RuleRecord[] { return this.repository.list(this.ownerTelegramId); }

  public get(ruleId: number): RuleRecord {
    const rule = this.repository.get(this.ownerTelegramId, ruleId);
    if (rule === undefined) throw new Error(`Rule not found: ${ruleId}`);
    return rule;
  }

  public create(input: RuleInput): RuleRecord {
    const validated = this.validate(input);
    const rule = this.repository.create(this.ownerTelegramId, validated);
    this.recordManagement('rule_created', 'created', rule, 'owner_created_rule');
    return rule;
  }

  public update(ruleId: number, input: RuleInput): RuleRecord {
    this.get(ruleId);
    const validated = this.validate(input, ruleId);
    const rule = this.repository.update(this.ownerTelegramId, ruleId, validated);
    this.recordManagement('rule_updated', 'updated', rule, 'owner_updated_rule');
    return rule;
  }

  public setEnabled(ruleId: number, enabled: boolean): RuleRecord {
    const current = this.get(ruleId);
    if (enabled && current.triggerKeywords.length === 0 && current.cleanupSenderPatterns.length === 0) {
      throw new Error('Rule needs at least one trigger or cleanup sender pattern before enabling');
    }
    const rule = this.repository.setEnabled(this.ownerTelegramId, ruleId, enabled);
    this.recordManagement(
      enabled ? 'rule_enabled' : 'rule_disabled',
      enabled ? 'enabled' : 'disabled',
      rule,
      enabled ? 'owner_enabled_rule' : 'owner_disabled_rule',
    );
    return rule;
  }

  public remove(ruleId: number): void {
    const rule = this.get(ruleId);
    this.repository.remove(this.ownerTelegramId, ruleId);
    this.recordManagement('rule_deleted', 'deleted', rule, 'owner_deleted_rule');
  }

  private validate(input: RuleInput, excludeId?: number): RuleInput {
    const name = input.name.trim().replace(/\s+/g, ' ');
    if (name.length < 1 || name.length > 64) throw new Error('Rule name must contain 1-64 characters');
    if (this.repository.findByName(this.ownerTelegramId, name, excludeId) !== undefined) {
      throw new Error('A rule with this name already exists');
    }
    if (this.channels.getForOwner(this.ownerTelegramId, input.channelId) === undefined) {
      throw new Error('Channel is not assigned to an account owned by this Owner');
    }
    if (input.replyTemplateId !== undefined) {
      const template = this.templates.getForOwner(input.replyTemplateId);
      const accountIsAssigned = this.channels
        .listAssignmentsForChannel(this.ownerTelegramId, input.channelId)
        .some((assignment) => assignment.accountId === template.accountId);
      if (!accountIsAssigned) {
        throw new Error('Reply template account is not assigned to the selected channel');
      }
    }
    return {
      name,
      channelId: input.channelId,
      triggerKeywords: normalizeValues(input.triggerKeywords, 'Trigger keyword'),
      excludeKeywords: normalizeValues(input.excludeKeywords, 'Exclude keyword'),
      cleanupSenderPatterns: normalizeValues(input.cleanupSenderPatterns, 'Cleanup sender pattern'),
      ...(input.replyTemplateId === undefined ? {} : { replyTemplateId: input.replyTemplateId }),
    };
  }

  private recordManagement(
    eventType: string,
    status: string,
    rule: RuleRecord,
    reason: string,
  ): void {
    const account = this.channels
      .listAssignmentsForChannel(this.ownerTelegramId, rule.channelId)
      .at(0);
    this.eventLogs.record({
      level: 'info',
      eventType,
      ...(account === undefined ? {} : { accountId: account.accountId }),
      channelId: rule.channelId,
      ...(eventType === 'rule_deleted' ? {} : { ruleId: rule.id }),
      action: eventType,
      status,
      reason,
    });
    this.logger.info(
      {
        account: account?.accountKey ?? 'owner-control',
        channel: rule.channelId,
        rule: rule.id,
        action: eventType,
        status,
        reason,
      },
      `Rule ${status}`,
    );
  }
}

function normalizeValues(values: readonly string[], label: string): string[] {
  const normalized = values
    .map((value) => value.trim().replace(/\s+/g, ' '))
    .filter((value) => value.length > 0);
  if (normalized.some((value) => value.length > 100)) throw new Error(`${label} must not exceed 100 characters`);
  return [...new Map(normalized.map((value) => [value.toLocaleLowerCase('id-ID'), value])).values()];
}
