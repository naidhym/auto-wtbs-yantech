import type { AppLogger } from '../logging/logger.js';
import { ReplyTemplateRepository } from './reply-template.repository.js';
import type { ReplyTemplateRecord } from './rule.types.js';

export class ReplyTemplateService {
  public constructor(
    private readonly repository: ReplyTemplateRepository,
    private readonly ownerTelegramId: string,
    private readonly logger: AppLogger,
  ) {}

  public list(accountKey: string): ReplyTemplateRecord[] {
    return this.repository.list(this.ownerTelegramId, accountKey);
  }

  public listForOwner(): ReplyTemplateRecord[] {
    return this.repository.listForOwner(this.ownerTelegramId);
  }

  public getActiveTemplate(accountKey: string): ReplyTemplateRecord | undefined {
    return this.repository.getActive(this.ownerTelegramId, accountKey);
  }

  public get(accountKey: string, templateId: number): ReplyTemplateRecord {
    const template = this.repository.get(this.ownerTelegramId, accountKey, templateId);
    if (template === undefined) throw new Error(`Reply template not found: ${templateId}`);
    return template;
  }

  public getForOwner(templateId: number): ReplyTemplateRecord {
    const template = this.repository.getForOwner(this.ownerTelegramId, templateId);
    if (template === undefined) throw new Error(`Reply template not found: ${templateId}`);
    return template;
  }

  public create(accountKey: string, name: string, body: string): ReplyTemplateRecord {
    const validated = this.validate(accountKey, name, body);
    const template = this.repository.create(
      this.ownerTelegramId,
      accountKey,
      validated.name,
      validated.body,
    );
    this.log('reply_template_created', 'created', template);
    return template;
  }

  public update(
    accountKey: string,
    templateId: number,
    name: string,
    body: string,
  ): ReplyTemplateRecord {
    this.get(accountKey, templateId);
    const validated = this.validate(accountKey, name, body, templateId);
    const template = this.repository.update(
      this.ownerTelegramId,
      accountKey,
      templateId,
      validated.name,
      validated.body,
    );
    this.log('reply_template_updated', 'updated', template);
    return template;
  }

  public setEnabled(
    accountKey: string,
    templateId: number,
    enabled: boolean,
  ): ReplyTemplateRecord {
    this.get(accountKey, templateId);
    const template = this.repository.setEnabled(
      this.ownerTelegramId,
      accountKey,
      templateId,
      enabled,
    );
    this.log(
      enabled ? 'reply_template_enabled' : 'reply_template_disabled',
      enabled ? 'enabled' : 'disabled',
      template,
    );
    return template;
  }

  public remove(accountKey: string, templateId: number): void {
    const template = this.get(accountKey, templateId);
    this.repository.remove(this.ownerTelegramId, accountKey, templateId);
    this.log('reply_template_deleted', 'deleted', template);
  }

  private validate(
    accountKey: string,
    name: string,
    body: string,
    excludeId?: number,
  ): { name: string; body: string } {
    const normalizedName = name.trim().replace(/\s+/g, ' ');
    const normalizedBody = body.trim();
    if (normalizedName.length < 1 || normalizedName.length > 64) {
      throw new Error('Template name must contain 1-64 characters');
    }
    if (normalizedBody.length < 1 || normalizedBody.length > 4000) {
      throw new Error('Template body must contain 1-4000 characters');
    }
    if (
      this.repository.findByName(
        this.ownerTelegramId,
        accountKey,
        normalizedName,
        excludeId,
      ) !== undefined
    ) {
      throw new Error('A reply template with this name already exists for this account');
    }
    return { name: normalizedName, body: normalizedBody };
  }

  private log(event: string, status: string, template: ReplyTemplateRecord): void {
    this.logger.info(
      {
        account: template.accountKey,
        action: event,
        status,
        template: template.id,
      },
      `Reply template ${status}`,
    );
  }
}
