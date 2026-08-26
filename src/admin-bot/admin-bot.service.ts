import { Markup, Telegraf, type Context } from 'telegraf';

import type { LoginStatus } from '../accounts/account-manager.service.js';
import type { AccountRecord } from '../accounts/account.types.js';
import type {
  AccountAutomationSettings,
  OwnerNotification,
} from '../automation/automation.types.js';
import type { ChannelAssignmentRecord, ChannelRecord } from '../channels/channel.types.js';
import { errorReason, type AppLogger } from '../logging/logger.js';
import type { ActionReportRecord } from '../logging/event-log.repository.js';
import type {
  ReplyTemplateRecord,
  RuleInput,
  RuleRecord,
} from '../rules/rule.types.js';
import { isOwner } from './authorization.js';

export interface AdminRuntimeStatus {
  readonly service: string;
  readonly state: string;
  readonly uptimeSeconds: number;
  readonly migrationVersion: number;
  readonly registeredTelegramClients: number;
  readonly connectedTelegramClients: number;
}

export interface AdminBotServiceOptions {
  readonly token: string;
  readonly ownerTelegramId: string;
  readonly logger: AppLogger;
  readonly statusProvider: () => AdminRuntimeStatus;
  readonly accountController?: AdminAccountController;
  readonly channelController?: AdminChannelController;
  readonly ruleController?: AdminRuleController;
  readonly replyTemplateController?: AdminReplyTemplateController;
  readonly keywordController?: AdminGlobalKeywordController;
  readonly automationSettingsController?: AdminAccountAutomationController;
  readonly automationSafetyController?: AdminAutomationSafetyController;
  readonly actionReportProvider?: AdminActionReportProvider;
}

export interface AdminAccountController {
  listAccounts(): AccountRecord[];
  getAccount(accountKey: string): AccountRecord;
  addAccount(input: { phoneNumber: string; label: string }): AccountRecord;
  validateNickname(nickname: string, excludeAccountKey?: string): string;
  rename(accountKey: string, nickname: string): AccountRecord;
  startLogin(accountKey: string): Promise<LoginStatus>;
  submitOtp(accountKey: string, otp: string): Promise<LoginStatus>;
  submitPassword(accountKey: string, password: string): Promise<LoginStatus>;
  cancelLogin(accountKey: string): Promise<LoginStatus>;
  reconnect(accountKey: string): Promise<unknown>;
  disconnect(accountKey: string): Promise<void>;
  enable(accountKey: string): Promise<AccountRecord>;
  disable(accountKey: string): Promise<AccountRecord>;
  remove(accountKey: string): Promise<void>;
  getLoginStatus(accountKey: string): LoginStatus | undefined;
}

export interface AdminChannelController {
  listChannels(): ChannelRecord[];
  listAccounts(): AccountRecord[];
  getChannel(channelId: number): { channel: ChannelRecord; assignments: ChannelAssignmentRecord[] };
  listAccountChannels(accountKey: string): Array<{ channel: ChannelRecord; assignment: ChannelAssignmentRecord }>;
  addChannel(identifier: string, accountKey: string): Promise<{ channel: ChannelRecord }>;
  assignAccount(channelId: number, accountKey: string): Promise<unknown>;
  unassign(assignmentId: number): Promise<void>;
  setChannelEnabled(channelId: number, enabled: boolean): Promise<unknown>;
  setAssignmentEnabled(assignmentId: number, enabled: boolean): Promise<unknown>;
  removeChannel(channelId: number): Promise<void>;
  stopAccountListeners(accountKey: string): Promise<void>;
  restartAccountListeners(accountKey: string): Promise<unknown>;
}

export interface AdminRuleController {
  list(): RuleRecord[];
  get(ruleId: number): RuleRecord;
  create(input: RuleInput): RuleRecord;
  update(ruleId: number, input: RuleInput): RuleRecord;
  setEnabled(ruleId: number, enabled: boolean): RuleRecord;
  remove(ruleId: number): void;
}

export interface AdminReplyTemplateController {
  list(accountKey: string): ReplyTemplateRecord[];
  get(accountKey: string, templateId: number): ReplyTemplateRecord;
  create(accountKey: string, name: string, body: string): ReplyTemplateRecord;
  update(accountKey: string, templateId: number, name: string, body: string): ReplyTemplateRecord;
  setEnabled(accountKey: string, templateId: number, enabled: boolean): ReplyTemplateRecord;
  remove(accountKey: string, templateId: number): void;
}

export interface AdminGlobalKeywordController {
  getConfiguration(): {
    readonly triggerKeywords: readonly string[];
    readonly excludeKeywords: readonly string[];
    readonly cleanupPatterns: readonly string[];
    readonly enabled: boolean;
  };
  setTriggerKeywords(value: string): readonly string[];
  setExcludeKeywords(value: string): readonly string[];
  setCleanupPatterns(value: string): readonly string[];
  setEnabled(enabled: boolean): unknown;
}

export interface AdminAccountAutomationController {
  get(accountKey: string): AccountAutomationSettings;
  setReplyDelay(accountKey: string, seconds: string): AccountAutomationSettings;
  setAutoReaction(accountKey: string, enabled: boolean): AccountAutomationSettings;
  setCooldown(accountKey: string, seconds: string): AccountAutomationSettings;
  setHourlyLimit(accountKey: string, value: string): AccountAutomationSettings;
  setDailyLimit(accountKey: string, value: string): AccountAutomationSettings;
  setNotificationTarget(accountKey: string, value: string): AccountAutomationSettings;
}

export interface AdminAutomationSafetyController {
  getStatus(): { readonly enabled: boolean };
  stopAll(): Promise<void>;
  resumeAll(): Promise<void>;
  resumeChannel(channelId: number): Promise<void>;
}

export interface AdminActionReportProvider {
  listActionReports(ownerTelegramId: string, offset: number, limit: number): ActionReportRecord[];
}

export interface AdminBotLifecycleAdapter {
  launch(bot: Telegraf, onReady: () => void): Promise<void>;
  stop(bot: Telegraf, reason: string): void;
}

type AdminConversationState =
  | { readonly step: 'awaiting_nickname' }
  | { readonly step: 'awaiting_phone'; readonly nickname: string }
  | { readonly step: 'awaiting_rename'; readonly accountKey: string }
  | { readonly step: 'starting_login'; readonly accountKey: string }
  | { readonly step: 'awaiting_otp'; readonly accountKey: string }
  | { readonly step: 'awaiting_password'; readonly accountKey: string }
  | { readonly step: 'awaiting_channel_identifiers' }
  | { readonly step: 'confirming_bulk_channels'; readonly resolvedChannels: BulkChannelResolutionState }
  | { readonly step: 'selecting_bulk_accounts'; readonly channelIds: number[] }
  | { readonly step: 'awaiting_channel_identifier' }
  | { readonly step: 'awaiting_channel_account'; readonly identifier: string }
  | { readonly step: 'awaiting_rule_name'; readonly ruleId?: number }
  | { readonly step: 'awaiting_rule_channel'; readonly draft: RuleDraft }
  | { readonly step: 'awaiting_rule_triggers'; readonly draft: RuleDraft }
  | { readonly step: 'awaiting_rule_excludes'; readonly draft: RuleDraft }
  | { readonly step: 'awaiting_rule_cleanup'; readonly draft: RuleDraft }
  | { readonly step: 'awaiting_rule_template'; readonly draft: RuleDraft }
  | {
      readonly step: 'awaiting_template_name';
      readonly accountKey: string;
      readonly templateId?: number;
    }
  | {
      readonly step: 'awaiting_template_body';
      readonly accountKey: string;
      readonly templateId?: number;
      readonly name: string;
    }
  | { readonly step: 'awaiting_global_triggers' }
  | { readonly step: 'awaiting_global_excludes' }
  | { readonly step: 'awaiting_global_cleanup' }
  | { readonly step: 'awaiting_reply_delay'; readonly accountKey: string }
  | { readonly step: 'awaiting_cooldown'; readonly accountKey: string }
  | { readonly step: 'awaiting_hourly_limit'; readonly accountKey: string }
  | { readonly step: 'awaiting_daily_limit'; readonly accountKey: string }
  | { readonly step: 'awaiting_notification_target'; readonly accountKey: string };

interface BulkChannelResolutionState {
  readonly valid: Array<{ id: number; title: string; username?: string }>;
  readonly invalid: Array<{ identifier: string; reason: string }>;
  readonly duplicates: Array<{ identifier: string; title: string }>;
}

interface RuleDraft {
  readonly ruleId?: number;
  readonly name: string;
  readonly channelId?: number;
  readonly triggerKeywords?: readonly string[];
  readonly excludeKeywords?: readonly string[];
  readonly cleanupSenderPatterns?: readonly string[];
}

const ACCOUNT_KEY_PATTERN = /^account-[a-f0-9-]{36}$/;
const PHONE_PATTERN = /^\+[1-9]\d{6,14}$/;

const defaultLifecycleAdapter: AdminBotLifecycleAdapter = {
  async launch(bot, onReady): Promise<void> {
    await bot.launch({
      allowedUpdates: ['message', 'callback_query'],
      dropPendingUpdates: false,
    }, onReady);
  },
  stop(bot, reason): void {
    bot.stop(reason);
  },
};

export class AdminBotService {
  private readonly bot: Telegraf;
  private readonly conversations = new Map<number, AdminConversationState>();
  private lifecycleState: 'stopped' | 'starting' | 'running' | 'stopping' | 'failed' =
    'stopped';
  private launchTask: Promise<void> | undefined;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;

  public constructor(
    private readonly options: AdminBotServiceOptions,
    private readonly lifecycleAdapter: AdminBotLifecycleAdapter = defaultLifecycleAdapter,
  ) {
    this.bot = new Telegraf(options.token);
    this.registerHandlers();
  }

  public async start(): Promise<void> {
    if (this.lifecycleState === 'running') return;
    if (this.startPromise !== undefined) return this.startPromise;
    if (this.lifecycleState === 'stopping') {
      throw new Error('Admin Bot cannot start while it is stopping');
    }

    this.startPromise = this.startInternal();
    return this.startPromise;
  }

  public stop(reason = 'application shutdown'): Promise<void> {
    if (this.lifecycleState === 'stopped' && this.launchTask === undefined) {
      return Promise.resolve();
    }
    if (this.stopPromise !== undefined) return this.stopPromise;

    this.stopPromise = this.stopInternal(reason);
    return this.stopPromise;
  }

  public isRunning(): boolean {
    return this.lifecycleState === 'running';
  }

  public async notifyOwner(notification: OwnerNotification): Promise<boolean> {
    if (!this.isRunning()) return false;
    await this.bot.telegram.sendMessage(
      this.options.ownerTelegramId,
      [
        '🚫 CHANNEL AUTOMATION BLOCKED',
        '',
        `Channel: ${notification.channelTitle}`,
        `Cleanup: ${notification.pattern}`,
        '',
        'All monitoring accounts were stopped for this channel. Resume manually from Channel Detail.',
      ].join('\n'),
    );
    return true;
  }

  private async startInternal(): Promise<void> {
    this.lifecycleState = 'starting';
    let ready = false;
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const readiness = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const markReady = (): void => {
      if (ready || this.lifecycleState !== 'starting') return;
      ready = true;
      this.lifecycleState = 'running';
      this.options.logger.info(
        { action: 'admin_bot_start', status: 'running' },
        'Owner-only Admin Bot started',
      );
      resolveReady();
    };

    const launched = Promise.resolve().then(async () =>
      this.lifecycleAdapter.launch(this.bot, markReady));
    this.launchTask = launched.then(
      () => {
        if (!ready && this.lifecycleState === 'stopping') {
          ready = true;
          resolveReady();
          return;
        }
        // Webhook/test adapters can have a finite launch promise. Long polling
        // normally reports readiness through the callback above.
        markReady();
      },
      (error: unknown) => {
        if (!ready && this.lifecycleState === 'stopping') {
          ready = true;
          resolveReady();
        } else if (!ready) {
          rejectReady(error);
        }
        if (this.lifecycleState !== 'stopping' && this.lifecycleState !== 'stopped') {
          this.lifecycleState = 'failed';
          this.options.logger.error(
            {
              action: 'admin_bot_polling',
              status: 'failed',
              errorReason: errorReason(error),
            },
            'Admin Bot polling stopped unexpectedly',
          );
        }
      },
    );

    await readiness;
  }

  private async stopInternal(reason: string): Promise<void> {
    this.lifecycleState = 'stopping';
    this.conversations.clear();

    while (this.launchTask !== undefined) {
      try {
        this.lifecycleAdapter.stop(this.bot, reason);
        break;
      } catch (error) {
        if (!/Bot is not running/i.test(errorReason(error))) throw error;
        const launchFinished = await Promise.race([
          this.launchTask.then(() => true),
          waitForAdminLifecycleTick().then(() => false),
        ]);
        if (launchFinished) break;
      }
    }

    await this.launchTask;
    this.lifecycleState = 'stopped';
    this.launchTask = undefined;
    this.startPromise = undefined;
    this.options.logger.info(
      { action: 'admin_bot_stop', status: 'stopped', reason },
      'Admin Bot stopped',
    );
  }

  private registerHandlers(): void {
    this.bot.use(async (context, next) => {
      const actorTelegramId = context.from?.id;

      if (!isOwner(actorTelegramId, this.options.ownerTelegramId)) {
        this.options.logger.warn(
          {
            account: actorTelegramId,
            action: 'admin_authorization',
            status: 'denied',
          },
          'Non-owner attempted to access Admin Bot',
        );

        if (context.callbackQuery !== undefined) {
          await context
            .answerCbQuery('⛔ Access denied.', { show_alert: true })
            .catch(() => undefined);
        } else if (context.chat?.type === 'private') {
          await context.reply('⛔ Access denied.');
        }

        return;
      }

      await next();
    });

    this.bot.start(async (context) => this.showMainMenu(context, false));
    this.registerMenuCallbacks();
    this.registerAccountCallbacks();
    this.registerChannelCallbacks();
    this.registerRuleCallbacks();
    this.registerTemplateCallbacks();
    this.registerGlobalConfigCallbacks();
    this.registerAutomationCallbacks();
    this.registerConversationHandler();
    this.registerLegacyCommands();

    this.bot.catch((error, context) => {
      this.options.logger.error(
        {
          account: context.from?.id,
          action: 'admin_bot_update',
          status: 'failed',
          errorReason: errorReason(error),
        },
        'Admin Bot update failed',
      );
    });
  }

  private registerMenuCallbacks(): void {
    this.bot.action('m:main', async (context) => {
      await acknowledgeCallback(context);
      await this.showMainMenu(context, true);
    });

    this.bot.action('m:accounts', async (context) => {
      await acknowledgeCallback(context);
      await this.showAccountsMenu(context, true);
    });

    this.bot.action('m:status', async (context) => {
      await acknowledgeCallback(context);
      await this.showStatus(context, true);
    });

    this.bot.action('m:health', async (context) => {
      await acknowledgeCallback(context);
      await this.showHealth(context, true);
    });

    this.bot.action('m:logs', async (context) => {
      await acknowledgeCallback(context);
      await this.showActionReports(context, 0, true);
    });

    this.bot.action(/^l:page:(\d+)$/, async (context) => {
      await acknowledgeCallback(context);
      await this.showActionReports(context, Number(context.match[1]), true);
    });

    this.bot.action('m:channels', async (context) => {
      await acknowledgeCallback(context);
      await this.showChannelsMenu(context, true);
    });

    this.bot.action('m:rules', async (context) => {
      await acknowledgeCallback(context);
      await this.showRulesMenu(context, true);
    });

    this.bot.action('m:templates', async (context) => {
      await acknowledgeCallback(context);
      await this.showTemplateAccountPicker(context, true);
    });

    this.bot.action('a:add', async (context) => {
      await acknowledgeCallback(context);
      const actorId = requireActorId(context);
      this.conversations.set(actorId, { step: 'awaiting_nickname' });
      await this.present(
        context,
        [
          '➕ Add Telegram Account',
          '',
          'Choose a unique nickname for this account.',
          'Example: Sales Jakarta',
        ].join('\n'),
        cancelKeyboard(),
        true,
      );
    });

    this.bot.action('flow:cancel', async (context) => {
      await acknowledgeCallback(context);
      await this.cancelConversation(context);
    });

    this.bot.action('c:add', async (context) => {
      await acknowledgeCallback(context);
      this.conversations.set(requireActorId(context), {
        step: 'awaiting_channel_identifiers',
      });
      await this.present(
        context,
        [
          '➕ Add Channels',
          '',
          'Send the Telegram channels you want to monitor.',
          'You can send multiple channels in one message.',
          '',
          'Examples:',
          '@channelname',
          'https://t.me/channelname',
          'https://t.me/+invite...',
          '-100123456789',
          '',
          'You can put one channel per line.',
        ].join('\n'),
        cancelKeyboard(),
        true,
      );
    });
  }

  private registerAccountCallbacks(): void {
    this.bot.action(/^a:o:(account-[a-f0-9-]{36})$/, async (context) => {
      await acknowledgeCallback(context);
      await this.showAccountDetail(context, requireCallbackAccountKey(context), true);
    });

    this.bot.action(/^a:li:(account-[a-f0-9-]{36})$/, async (context) => {
      await acknowledgeCallback(context);
      await this.withAdminError(context, async () => {
        await this.beginLogin(
          context,
          requireCallbackAccountKey(context),
          true,
        );
      });
    });

    this.bot.action(/^a:rn:(account-[a-f0-9-]{36})$/, async (context) => {
      await acknowledgeCallback(context);
      const actorId = requireActorId(context);
      const accountKey = requireCallbackAccountKey(context);
      const account = this.requireController().getAccount(accountKey);
      this.conversations.set(actorId, { step: 'awaiting_rename', accountKey });
      await this.present(
        context,
        [
          '✏️ Rename Account',
          '',
          `Current nickname: ${account.nickname}`,
          'Send a new unique nickname.',
        ].join('\n'),
        cancelKeyboard(),
        true,
      );
    });

    this.bot.action(/^a:rc:(account-[a-f0-9-]{36})$/, async (context) => {
      await acknowledgeCallback(context);
      await this.withAdminError(context, async () => {
        const accountKey = requireCallbackAccountKey(context);
        await this.options.channelController?.stopAccountListeners(accountKey);
        await this.requireController().reconnect(accountKey);
        await this.options.channelController?.restartAccountListeners(accountKey);
        await this.showAccountDetail(context, accountKey, true, '✅ Reconnected.');
      });
    });

    this.bot.action(/^a:dc:(account-[a-f0-9-]{36})$/, async (context) => {
      await acknowledgeCallback(context);
      await this.withAdminError(context, async () => {
        const accountKey = requireCallbackAccountKey(context);
        await this.options.channelController?.stopAccountListeners(accountKey);
        await this.requireController().disconnect(accountKey);
        await this.showAccountDetail(context, accountKey, true, '🔌 Disconnected.');
      });
    });

    this.bot.action(/^a:en:(account-[a-f0-9-]{36})$/, async (context) => {
      await acknowledgeCallback(context);
      await this.withAdminError(context, async () => {
        const accountKey = requireCallbackAccountKey(context);
        await this.requireController().enable(accountKey);
        await this.options.channelController?.restartAccountListeners(accountKey);
        await this.showAccountDetail(context, accountKey, true, '▶️ Account enabled.');
      });
    });

    this.bot.action(/^a:di:(account-[a-f0-9-]{36})$/, async (context) => {
      await acknowledgeCallback(context);
      await this.withAdminError(context, async () => {
        const accountKey = requireCallbackAccountKey(context);
        await this.options.channelController?.stopAccountListeners(accountKey);
        await this.requireController().disable(accountKey);
        await this.showAccountDetail(context, accountKey, true, '⏸ Account disabled.');
      });
    });

    this.bot.action(/^a:rm:(account-[a-f0-9-]{36})$/, async (context) => {
      await acknowledgeCallback(context);
      await this.showRemoveConfirmation(
        context,
        requireCallbackAccountKey(context),
        true,
      );
    });

    this.bot.action(/^a:no:(account-[a-f0-9-]{36})$/, async (context) => {
      await acknowledgeCallback(context);
      await this.showAccountDetail(context, requireCallbackAccountKey(context), true);
    });

    this.bot.action(/^a:yes:(account-[a-f0-9-]{36})$/, async (context) => {
      await acknowledgeCallback(context);
      await this.withAdminError(context, async () => {
        const accountKey = requireCallbackAccountKey(context);
        await this.options.channelController?.stopAccountListeners(accountKey);
        await this.requireController().remove(accountKey);
        await this.showAccountsMenu(context, true, '🗑 Account removed.');
      });
    });
  }

  private registerChannelCallbacks(): void {
    this.bot.action(/^c:o:(\d+)$/, async (context) => {
      await acknowledgeCallback(context);
      await this.withAdminError(context, async () =>
        this.showChannelDetail(context, callbackNumber(context), true));
    });
    this.bot.action(/^c:pick:(\d+)$/, async (context) => {
      await acknowledgeCallback(context);
      await this.withAdminError(context, async () => {
        const actorId = requireActorId(context);
        const state = this.conversations.get(actorId);
        if (state?.step !== 'awaiting_channel_account') {
          throw new Error('Add channel flow has expired');
        }
        const account = this.requireChannelController().listAccounts()
          .find((item) => item.id === callbackNumber(context));
        if (account === undefined) throw new Error('Selected account was not found');
        const detail = await this.requireChannelController()
          .addChannel(state.identifier, account.accountKey);
        this.conversations.delete(actorId);
        await this.showChannelDetail(
          context,
          detail.channel.id,
          true,
          '✅ Channel validated and saved.',
        );
      });
    });
    this.bot.action(/^c:ac:(\d+)$/, async (context) => {
      await acknowledgeCallback(context);
      await this.showChannelAccounts(context, callbackNumber(context), true);
    });
    this.bot.action(/^c:as:(\d+):(\d+)$/, async (context) => {
      await acknowledgeCallback(context);
      await this.withAdminError(context, async () => {
        const [channelId, accountId] = callbackPair(context);
        const account = this.requireChannelController().listAccounts()
          .find((item) => item.id === accountId);
        if (account === undefined) throw new Error('Selected account was not found');
        await this.requireChannelController().assignAccount(channelId, account.accountKey);
        await this.showChannelAccounts(context, channelId, true, '✅ Account assigned.');
      });
    });
    this.bot.action(/^c:un:(\d+):(\d+)$/, async (context) => {
      await acknowledgeCallback(context);
      await this.withAdminError(context, async () => {
        const [channelId, assignmentId] = callbackPair(context);
        await this.requireChannelController().unassign(assignmentId);
        await this.showChannelAccounts(context, channelId, true, '✅ Account unassigned.');
      });
    });
    for (const [action, enabled] of [['ae', true], ['ad', false]] as const) {
      this.bot.action(new RegExp(`^c:${action}:(\\d+):(\\d+)$`), async (context) => {
        await acknowledgeCallback(context);
        await this.withAdminError(context, async () => {
          const [channelId, assignmentId] = callbackPair(context);
          await this.requireChannelController().setAssignmentEnabled(assignmentId, enabled);
          await this.showChannelAccounts(
            context,
            channelId,
            true,
            enabled ? '▶️ Monitoring enabled.' : '⏸ Monitoring disabled.',
          );
        });
      });
    }
    for (const [action, enabled] of [['en', true], ['di', false]] as const) {
      this.bot.action(new RegExp(`^c:${action}:(\\d+)$`), async (context) => {
        await acknowledgeCallback(context);
        await this.withAdminError(context, async () => {
          const channelId = callbackNumber(context);
          await this.requireChannelController().setChannelEnabled(channelId, enabled);
          await this.showChannelDetail(
            context,
            channelId,
            true,
            enabled ? '▶️ Channel enabled.' : '⏸ Channel disabled.',
          );
        });
      });
    }
    this.bot.action(/^c:rm:(\d+)$/, async (context) => {
      await acknowledgeCallback(context);
      const channelId = callbackNumber(context);
      const detail = this.requireChannelController().getChannel(channelId);
      await this.present(
        context,
        ['⚠️ Remove Channel?', '', detail.channel.title, 'All account assignments for this channel will be removed.'].join('\n'),
        Markup.inlineKeyboard([[
          Markup.button.callback('⚠️ Yes, Remove', `c:yes:${channelId}`),
          Markup.button.callback('❌ Cancel', `c:o:${channelId}`),
        ]]),
        true,
      );
    });
    this.bot.action(/^c:yes:(\d+)$/, async (context) => {
      await acknowledgeCallback(context);
      await this.withAdminError(context, async () => {
        await this.requireChannelController().removeChannel(callbackNumber(context));
        await this.showChannelsMenu(context, true, '🗑 Channel removed.');
      });
    });
    this.bot.action(/^a:ch:(account-[a-f0-9-]{36})$/, async (context) => {
      await acknowledgeCallback(context);
      await this.showAccountChannels(context, requireCallbackAccountKey(context), true);
    });
  }

  private registerRuleCallbacks(): void {
    this.bot.action('r:add', async (context) => {
      await acknowledgeCallback(context);
      this.conversations.set(requireActorId(context), { step: 'awaiting_rule_name' });
      await this.present(
        context,
        ['➕ Add Rule', '', 'Send a unique rule name.'].join('\n'),
        cancelKeyboard(),
        true,
      );
    });
    this.bot.action(/^r:o:(\d+)$/, async (context) => {
      await acknowledgeCallback(context);
      await this.withAdminError(context, async () =>
        this.showRuleDetail(context, callbackNumber(context), true));
    });
    this.bot.action(/^r:ed:(\d+)$/, async (context) => {
      await acknowledgeCallback(context);
      const rule = this.requireRuleController().get(callbackNumber(context));
      this.conversations.set(requireActorId(context), {
        step: 'awaiting_rule_name',
        ruleId: rule.id,
      });
      await this.present(
        context,
        ['✏️ Edit Rule', '', `Current name: ${rule.name}`, 'Send the rule name to continue.'].join('\n'),
        cancelKeyboard(),
        true,
      );
    });
    for (const [action, enabled] of [['en', true], ['di', false]] as const) {
      this.bot.action(new RegExp(`^r:${action}:(\\d+)$`), async (context) => {
        await acknowledgeCallback(context);
        await this.withAdminError(context, async () => {
          const rule = this.requireRuleController().setEnabled(callbackNumber(context), enabled);
          await this.showRuleDetail(
            context,
            rule.id,
            true,
            enabled ? '✅ Rule enabled.' : '⏸ Rule disabled.',
          );
        });
      });
    }
    this.bot.action(/^r:rm:(\d+)$/, async (context) => {
      await acknowledgeCallback(context);
      const rule = this.requireRuleController().get(callbackNumber(context));
      await this.present(
        context,
        ['⚠️ Delete Rule?', '', rule.name, 'Detection configuration will be removed.'].join('\n'),
        Markup.inlineKeyboard([[
          Markup.button.callback('⚠️ Yes, Delete', `r:yes:${rule.id}`),
          Markup.button.callback('❌ Cancel', `r:o:${rule.id}`),
        ]]),
        true,
      );
    });
    this.bot.action(/^r:yes:(\d+)$/, async (context) => {
      await acknowledgeCallback(context);
      await this.withAdminError(context, async () => {
        this.requireRuleController().remove(callbackNumber(context));
        await this.showRulesMenu(context, true, '🗑 Rule deleted.');
      });
    });
    this.bot.action(/^r:ch:(\d+)$/, async (context) => {
      await acknowledgeCallback(context);
      const actorId = requireActorId(context);
      const state = this.conversations.get(actorId);
      if (state?.step !== 'awaiting_rule_channel') throw new Error('Rule flow has expired');
      const channelId = callbackNumber(context);
      this.requireChannelController().getChannel(channelId);
      this.conversations.set(actorId, {
        step: 'awaiting_rule_triggers',
        draft: { ...state.draft, channelId },
      });
      await this.present(
        context,
        ['🔎 Trigger Keywords', '', 'Send comma-separated trigger keywords.', 'Example: bucin, wtb'].join('\n'),
        cancelKeyboard(),
        true,
      );
    });
    this.bot.action(/^r:tp:(\d+)$/, async (context) => {
      await acknowledgeCallback(context);
      await this.withAdminError(context, async () =>
        this.finishRuleFlow(context, callbackNumber(context)));
    });
    this.bot.action('r:tn', async (context) => {
      await acknowledgeCallback(context);
      await this.withAdminError(context, async () => this.finishRuleFlow(context));
    });
  }

  private registerTemplateCallbacks(): void {
    this.bot.action(/^a:tp:(account-[a-f0-9-]{36})$/, async (context) => {
      await acknowledgeCallback(context);
      await this.showTemplatesMenu(context, requireCallbackAccountKey(context), true);
    });
    this.bot.action(/^t:list:(account-[a-f0-9-]{36})$/, async (context) => {
      await acknowledgeCallback(context);
      await this.showTemplatesMenu(context, requireCallbackAccountKey(context), true);
    });
    this.bot.action(/^t:add:(account-[a-f0-9-]{36})$/, async (context) => {
      await acknowledgeCallback(context);
      const accountKey = requireCallbackAccountKey(context);
      const account = this.requireController().getAccount(accountKey);
      this.conversations.set(requireActorId(context), {
        step: 'awaiting_template_name',
        accountKey,
      });
      await this.present(
        context,
        [
          '➕ Add Reply Template',
          '',
          `Account: ${account.nickname}`,
          'Send a unique template name for this account.',
        ].join('\n'),
        cancelKeyboard(),
        true,
      );
    });
    this.bot.action(/^t:o:(account-[a-f0-9-]{36}):(\d+)$/, async (context) => {
      await acknowledgeCallback(context);
      const target = requireTemplateCallback(context);
      await this.withAdminError(context, async () => {
        await this.showTemplateDetail(context, target.accountKey, target.templateId, true);
      });
    });
    this.bot.action(/^t:ed:(account-[a-f0-9-]{36}):(\d+)$/, async (context) => {
      await acknowledgeCallback(context);
      const target = requireTemplateCallback(context);
      const template = this.requireTemplateController().get(
        target.accountKey,
        target.templateId,
      );
      this.conversations.set(requireActorId(context), {
        step: 'awaiting_template_name',
        accountKey: target.accountKey,
        templateId: template.id,
      });
      await this.present(
        context,
        ['✏️ Edit Reply Template', '', `Current name: ${template.name}`, 'Send the template name to continue.'].join('\n'),
        cancelKeyboard(),
        true,
      );
    });
    for (const [action, enabled] of [['en', true], ['di', false]] as const) {
      this.bot.action(
        new RegExp(`^t:${action}:(account-[a-f0-9-]{36}):(\\d+)$`),
        async (context) => {
        await acknowledgeCallback(context);
        await this.withAdminError(context, async () => {
          const target = requireTemplateCallback(context);
          const template = this.requireTemplateController()
            .setEnabled(target.accountKey, target.templateId, enabled);
          await this.showTemplateDetail(
            context,
            target.accountKey,
            template.id,
            true,
            enabled ? '✅ Template enabled.' : '⏸ Template disabled.',
          );
        });
        },
      );
    }
    this.bot.action(/^t:rm:(account-[a-f0-9-]{36}):(\d+)$/, async (context) => {
      await acknowledgeCallback(context);
      const target = requireTemplateCallback(context);
      const template = this.requireTemplateController().get(
        target.accountKey,
        target.templateId,
      );
      await this.present(
        context,
        [
          '⚠️ Delete Reply Template?',
          '',
          `Account: ${template.accountNickname}`,
          template.name,
          'Linked rules will keep working without a template.',
        ].join('\n'),
        Markup.inlineKeyboard([[
          Markup.button.callback(
            '⚠️ Yes, Delete',
            `t:yes:${target.accountKey}:${template.id}`,
          ),
          Markup.button.callback(
            '❌ Cancel',
            `t:o:${target.accountKey}:${template.id}`,
          ),
        ]]),
        true,
      );
    });
    this.bot.action(/^t:yes:(account-[a-f0-9-]{36}):(\d+)$/, async (context) => {
      await acknowledgeCallback(context);
      await this.withAdminError(context, async () => {
        const target = requireTemplateCallback(context);
        this.requireTemplateController().remove(target.accountKey, target.templateId);
        await this.showTemplatesMenu(
          context,
          target.accountKey,
          true,
          '🗑 Reply template deleted.',
        );
      });
    });
  }

  private registerGlobalConfigCallbacks(): void {
    this.bot.action('g:tr', async (context) => {
      await acknowledgeCallback(context);
      await this.beginGlobalKeywordInput(context, 'trigger');
    });
    this.bot.action('g:ex', async (context) => {
      await acknowledgeCallback(context);
      await this.beginGlobalKeywordInput(context, 'exclude');
    });
    this.bot.action('g:cl', async (context) => {
      await acknowledgeCallback(context);
      await this.beginGlobalKeywordInput(context, 'cleanup');
    });
    this.bot.action('g:st', async (context) => {
      await acknowledgeCallback(context);
      await this.showRuleSettings(context, true);
    });
    this.bot.action(/^g:(en|di)$/, async (context) => {
      await acknowledgeCallback(context);
      await this.withAdminError(context, async () => {
        const enabled = context.match[1] === 'en';
        this.requireKeywordController().setEnabled(enabled);
        await this.showRuleSettings(
          context,
          true,
          enabled ? '✅ Global detection enabled.' : '⏸ Global detection disabled.',
        );
      });
    });
  }

  private registerAutomationCallbacks(): void {
    this.bot.action(/^a:auto:(account-[a-f0-9-]{36})$/, async (context) => {
      await acknowledgeCallback(context);
      await this.showAccountAutomationSettings(
        context,
        requireCallbackAccountKey(context),
        true,
      );
    });
    for (const [action, step, title, prompt] of [
      ['delay', 'awaiting_reply_delay', '⏱ Reply Delay', 'Send seconds from 0 to 600. Decimals are supported.'],
      ['cool', 'awaiting_cooldown', '⏳ Cooldown', 'Send minimum seconds between successful replies. Use 0 to disable.'],
      ['hour', 'awaiting_hourly_limit', 'Hourly Limit', 'Send maximum replies per rolling hour. Use 0 for unlimited.'],
      ['day', 'awaiting_daily_limit', 'Daily Limit', 'Send maximum replies per rolling 24 hours. Use 0 for unlimited.'],
      ['notify', 'awaiting_notification_target', 'Notification Bot', 'Send @MonitoringBot or a numeric Telegram ID. Send - to disable operational notifications.'],
    ] as const) {
      this.bot.action(
        new RegExp(`^a:${action}:(account-[a-f0-9-]{36})$`),
        async (context) => {
          await acknowledgeCallback(context);
          const accountKey = requireCallbackAccountKey(context);
          this.requireAutomationSettingsController().get(accountKey);
          this.conversations.set(requireActorId(context), { step, accountKey });
          await this.present(
            context,
            [title, '', prompt].join('\n'),
            cancelKeyboard(),
            true,
          );
        },
      );
    }
    this.bot.action(/^a:reaction:(account-[a-f0-9-]{36})$/, async (context) => {
      await acknowledgeCallback(context);
      await this.showReactionSettings(context, requireCallbackAccountKey(context), true);
    });
    this.bot.action(/^a:re:(on|off):(account-[a-f0-9-]{36})$/, async (context) => {
      await acknowledgeCallback(context);
      await this.withAdminError(context, async () => {
        const accountKey = requireCallbackAccountKey(context);
        const data = callbackData(context);
        const enabled = data.split(':').at(-2) === 'on';
        this.requireAutomationSettingsController().setAutoReaction(accountKey, enabled);
        await this.showReactionSettings(
          context,
          accountKey,
          true,
          enabled ? '✅ Auto Reaction enabled.' : '⏸ Auto Reaction disabled.',
        );
      });
    });
    this.bot.action(/^a:limits:(account-[a-f0-9-]{36})$/, async (context) => {
      await acknowledgeCallback(context);
      await this.showAccountLimits(context, requireCallbackAccountKey(context), true);
    });
    this.bot.action('auto:stop', async (context) => {
      await acknowledgeCallback(context);
      await this.present(
        context,
        ['🚨 STOP ALL?', '', 'This stops all automation without deleting configuration.'].join('\n'),
        Markup.inlineKeyboard([[
          Markup.button.callback('🚨 Yes, STOP ALL', 'auto:stop:yes'),
          Markup.button.callback('❌ Cancel', 'm:main'),
        ]]),
        true,
      );
    });
    this.bot.action('auto:stop:yes', async (context) => {
      await acknowledgeCallback(context);
      await this.withAdminError(context, async () => {
        await this.requireAutomationSafetyController().stopAll();
        await this.showMainMenu(context, true, '🚨 All automation stopped.');
      });
    });
    this.bot.action('auto:resume', async (context) => {
      await acknowledgeCallback(context);
      await this.withAdminError(context, async () => {
        await this.requireAutomationSafetyController().resumeAll();
        await this.showMainMenu(context, true, '▶️ All eligible automation resumed.');
      });
    });
    this.bot.action(/^c:resume:(\d+)$/, async (context) => {
      await acknowledgeCallback(context);
      await this.withAdminError(context, async () => {
        const channelId = callbackNumber(context);
        await this.requireAutomationSafetyController().resumeChannel(channelId);
        await this.showChannelDetail(context, channelId, true, '▶️ Channel automation resumed.');
      });
    });
  }

  private async beginGlobalKeywordInput(
    context: Context,
    type: 'trigger' | 'exclude' | 'cleanup',
  ): Promise<void> {
    const configuration = this.requireKeywordController().getConfiguration();
    const details = {
      trigger: {
        title: '🎯 Trigger Keywords',
        current: configuration.triggerKeywords,
        example: 'bucin, mensive, bulol',
        step: 'awaiting_global_triggers' as const,
      },
      exclude: {
        title: '🚫 Exclude Keywords',
        current: configuration.excludeKeywords,
        example: 'fmv, channel, ch',
        step: 'awaiting_global_excludes' as const,
      },
      cleanup: {
        title: '🧹 Cleanup Patterns',
        current: configuration.cleanupPatterns,
        example: 'JGN REPLY, NO REPLY',
        step: 'awaiting_global_cleanup' as const,
      },
    }[type];
    this.conversations.set(requireActorId(context), { step: details.step });
    await this.present(
      context,
      [
        details.title,
        '',
        `Current: ${formatValues(details.current)}`,
        '',
        'Send values separated by commas.',
        `Example: ${details.example}`,
      ].join('\n'),
      cancelKeyboard(),
      true,
    );
  }

  private registerConversationHandler(): void {
    this.bot.on('text', async (context) => {
      const actorId = context.from.id;
      const state = this.conversations.get(actorId);

      if (state === undefined || context.message.text.startsWith('/')) {
        return;
      }

      if (state.step === 'awaiting_nickname') {
        await this.handleNicknameInput(context, context.message.text);
        return;
      }

      if (state.step === 'awaiting_phone') {
        await this.handlePhoneInput(context, state.nickname, context.message.text);
        return;
      }

      if (state.step === 'awaiting_rename') {
        await this.handleRenameInput(context, state.accountKey, context.message.text);
        return;
      }

      if (state.step === 'awaiting_otp') {
        await this.handleOtpInput(context, state.accountKey, context.message.text);
        return;
      }

      if (state.step === 'awaiting_password') {
        await this.handlePasswordInput(context, state.accountKey, context.message.text);
        return;
      }

      if (state.step === 'awaiting_channel_identifier') {
        await this.handleChannelIdentifierInput(context, context.message.text);
        return;
      }

      if (state.step === 'awaiting_channel_identifiers') {
        await this.handleBulkChannelIdentifiersInput(context, context.message.text);
        return;
      }

      if (state.step === 'awaiting_global_triggers') {
        await this.handleGlobalConfigInput(context, 'trigger', context.message.text);
        return;
      }

      if (state.step === 'awaiting_global_excludes') {
        await this.handleGlobalConfigInput(context, 'exclude', context.message.text);
        return;
      }

      if (state.step === 'awaiting_global_cleanup') {
        await this.handleGlobalConfigInput(context, 'cleanup', context.message.text);
        return;
      }

      if (
        state.step === 'awaiting_reply_delay' ||
        state.step === 'awaiting_cooldown' ||
        state.step === 'awaiting_hourly_limit' ||
        state.step === 'awaiting_daily_limit' ||
        state.step === 'awaiting_notification_target'
      ) {
        await this.handleAutomationSettingInput(
          context,
          state.step,
          state.accountKey,
          context.message.text,
        );
        return;
      }

      if (state.step === 'awaiting_rule_name') {
        await this.handleRuleNameInput(context, state.ruleId, context.message.text);
        return;
      }

      if (state.step === 'awaiting_rule_triggers') {
        await this.handleRuleTriggersInput(context, state.draft, context.message.text);
        return;
      }

      if (state.step === 'awaiting_rule_excludes') {
        await this.handleRuleExcludesInput(context, state.draft, context.message.text);
        return;
      }

      if (state.step === 'awaiting_rule_cleanup') {
        await this.handleRuleCleanupInput(context, state.draft, context.message.text);
        return;
      }

      if (state.step === 'awaiting_template_name') {
        await this.handleTemplateNameInput(
          context,
          state.accountKey,
          state.templateId,
          context.message.text,
        );
        return;
      }

      if (state.step === 'awaiting_template_body') {
        await this.handleTemplateBodyInput(
          context,
          state.accountKey,
          state.templateId,
          state.name,
          context.message.text,
        );
      }
    });
  }

  private async handleGlobalConfigInput(
    context: Context,
    type: 'trigger' | 'exclude' | 'cleanup',
    value: string,
  ): Promise<void> {
    await this.withAdminError(context, async () => {
      const controller = this.requireKeywordController();
      const values = type === 'trigger'
        ? controller.setTriggerKeywords(value)
        : type === 'exclude'
          ? controller.setExcludeKeywords(value)
          : controller.setCleanupPatterns(value);
      this.conversations.delete(requireActorId(context));
      await this.showRulesMenu(
        context,
        false,
        `✅ ${typeLabel(type)} updated (${values.length}).`,
      );
    });
  }

  private async handleAutomationSettingInput(
    context: Context,
    step:
      | 'awaiting_reply_delay'
      | 'awaiting_cooldown'
      | 'awaiting_hourly_limit'
      | 'awaiting_daily_limit'
      | 'awaiting_notification_target',
    accountKey: string,
    value: string,
  ): Promise<void> {
    await this.withAdminError(context, async () => {
      const controller = this.requireAutomationSettingsController();
      if (step === 'awaiting_reply_delay') controller.setReplyDelay(accountKey, value);
      if (step === 'awaiting_cooldown') controller.setCooldown(accountKey, value);
      if (step === 'awaiting_hourly_limit') controller.setHourlyLimit(accountKey, value);
      if (step === 'awaiting_daily_limit') controller.setDailyLimit(accountKey, value);
      if (step === 'awaiting_notification_target') controller.setNotificationTarget(accountKey, value);
      this.conversations.delete(requireActorId(context));
      await this.showAccountAutomationSettings(
        context,
        accountKey,
        false,
        '✅ Auto reply settings updated.',
      );
    });
  }

  private async handleRuleNameInput(
    context: Context,
    ruleId: number | undefined,
    rawName: string,
  ): Promise<void> {
    const name = rawName.trim().replace(/\s+/g, ' ');
    if (name.length < 1 || name.length > 64) {
      await context.reply('Rule name must contain 1-64 characters.', cancelKeyboard());
      return;
    }
    const channels = this.requireChannelController().listChannels();
    if (channels.length === 0) {
      await context.reply('Add and validate a channel before creating rules.', cancelKeyboard());
      return;
    }
    this.conversations.set(requireActorId(context), {
      step: 'awaiting_rule_channel',
      draft: { ...(ruleId === undefined ? {} : { ruleId }), name },
    });
    await context.reply(
      ['📡 Rule Channel', '', 'Choose the channel scope:'].join('\n'),
      Markup.inlineKeyboard([
        ...channels.map((channel) => [Markup.button.callback(
          truncateLabel(channel.title),
          `r:ch:${channel.id}`,
        )]),
        [Markup.button.callback('❌ Cancel', 'flow:cancel')],
      ]),
    );
  }

  private async handleRuleTriggersInput(
    context: Context,
    draft: RuleDraft,
    value: string,
  ): Promise<void> {
    const triggerKeywords = parseAdminValues(value);
    if (triggerKeywords.length === 0) {
      await context.reply('Send at least one trigger keyword.', cancelKeyboard());
      return;
    }
    this.conversations.set(requireActorId(context), {
      step: 'awaiting_rule_excludes',
      draft: { ...draft, triggerKeywords },
    });
    await context.reply(
      ['🚫 Exclude Keywords', '', 'Send comma-separated exclude keywords.', 'Send - if none.'].join('\n'),
      cancelKeyboard(),
    );
  }

  private async handleRuleExcludesInput(
    context: Context,
    draft: RuleDraft,
    value: string,
  ): Promise<void> {
    this.conversations.set(requireActorId(context), {
      step: 'awaiting_rule_cleanup',
      draft: { ...draft, excludeKeywords: parseAdminValues(value) },
    });
    await context.reply(
      [
        '🧹 Cleanup Sender Name',
        '',
        'Patterns are matched against sender/display name, not message text.',
        'Send comma-separated patterns. Send - to use default: JGN REPLY',
      ].join('\n'),
      cancelKeyboard(),
    );
  }

  private async handleRuleCleanupInput(
    context: Context,
    draft: RuleDraft,
    value: string,
  ): Promise<void> {
    const cleanupSenderPatterns = value.trim() === '-'
      ? ['JGN REPLY']
      : parseAdminValues(value);
    const completed = { ...draft, cleanupSenderPatterns };
    this.conversations.set(requireActorId(context), {
      step: 'awaiting_rule_template',
      draft: completed,
    });
    if (draft.channelId === undefined) throw new Error('Rule channel is unavailable');
    const templates = this.requireChannelController()
      .getChannel(draft.channelId)
      .assignments
      .flatMap((assignment) =>
        this.requireTemplateController().list(assignment.accountKey));
    await context.reply(
      ['📝 Optional Reply Template', '', 'Choose a template or continue without one.', 'M4 will not send it.'].join('\n'),
      Markup.inlineKeyboard([
        ...templates.map((template) => [Markup.button.callback(
          `${template.enabled ? '🟢' : '⏸'} ${truncateLabel(template.accountNickname)} · ${truncateLabel(template.name)}`,
          `r:tp:${template.id}`,
        )]),
        [Markup.button.callback('Continue Without Template', 'r:tn')],
        [Markup.button.callback('❌ Cancel', 'flow:cancel')],
      ]),
    );
  }

  private async finishRuleFlow(context: Context, replyTemplateId?: number): Promise<void> {
    const actorId = requireActorId(context);
    const state = this.conversations.get(actorId);
    if (state?.step !== 'awaiting_rule_template') throw new Error('Rule flow has expired');
    const draft = state.draft;
    if (
      draft.channelId === undefined ||
      draft.triggerKeywords === undefined ||
      draft.excludeKeywords === undefined ||
      draft.cleanupSenderPatterns === undefined
    ) {
      throw new Error('Rule draft is incomplete');
    }
    const input: RuleInput = {
      name: draft.name,
      channelId: draft.channelId,
      triggerKeywords: draft.triggerKeywords,
      excludeKeywords: draft.excludeKeywords,
      cleanupSenderPatterns: draft.cleanupSenderPatterns,
      ...(replyTemplateId === undefined ? {} : { replyTemplateId }),
    };
    const rule = draft.ruleId === undefined
      ? this.requireRuleController().create(input)
      : this.requireRuleController().update(draft.ruleId, input);
    this.conversations.delete(actorId);
    await this.showRuleDetail(
      context,
      rule.id,
      true,
      draft.ruleId === undefined ? '✅ Rule created.' : '✅ Rule updated.',
    );
  }

  private async handleTemplateNameInput(
    context: Context,
    accountKey: string,
    templateId: number | undefined,
    value: string,
  ): Promise<void> {
    const name = value.trim().replace(/\s+/g, ' ');
    if (name.length < 1 || name.length > 64) {
      await context.reply('Template name must contain 1-64 characters.', cancelKeyboard());
      return;
    }
    this.conversations.set(requireActorId(context), {
      step: 'awaiting_template_body',
      accountKey,
      ...(templateId === undefined ? {} : { templateId }),
      name,
    });
    await context.reply('Send the reply template body (maximum 4000 characters).', cancelKeyboard());
  }

  private async handleTemplateBodyInput(
    context: Context,
    accountKey: string,
    templateId: number | undefined,
    name: string,
    body: string,
  ): Promise<void> {
    await this.withAdminError(context, async () => {
      const template = templateId === undefined
        ? this.requireTemplateController().create(accountKey, name, body)
        : this.requireTemplateController().update(accountKey, templateId, name, body);
      this.conversations.delete(requireActorId(context));
      await this.showTemplateDetail(
        context,
        accountKey,
        template.id,
        false,
        templateId === undefined ? '✅ Reply template created.' : '✅ Reply template updated.',
      );
    });
  }

  private async handleChannelIdentifierInput(
    context: Context,
    identifier: string,
  ): Promise<void> {
    const accounts = this.requireChannelController()
      .listAccounts()
      .filter((account) => account.enabled && account.status === 'connected');

    if (accounts.length === 0) {
      await context.reply(
        'No enabled, connected account is available for channel validation.',
        cancelKeyboard(),
      );
      return;
    }

    const normalized = identifier.trim();
    this.conversations.set(requireActorId(context), {
      step: 'awaiting_channel_account',
      identifier: normalized,
    });
    await context.reply(
      [
        '🔎 Validate Channel',
        '',
        `Input: ${normalized}`,
        'Choose the Telegram account that already has access:',
      ].join('\n'),
      Markup.inlineKeyboard([
        ...accounts.map((account) => [
          Markup.button.callback(
            `👤 ${truncateLabel(account.nickname)}`,
            `c:pick:${account.id}`,
          ),
        ]),
        [Markup.button.callback('❌ Cancel', 'flow:cancel')],
      ]),
    );
  }

  private async handleBulkChannelIdentifiersInput(
    context: Context,
    input: string,
  ): Promise<void> {
    await this.withAdminError(context, async () => {
      const text = input.trim();
      if (text.length === 0) {
        throw new Error('Please send at least one channel identifier');
      }

      // For now, treat as single identifier and delegate to original handler
      // This maintains backward compatibility while the bulk UI is being completed
      await this.handleChannelIdentifierInput(context, text);
    });
  }

  private registerLegacyCommands(): void {
    this.bot.command('status', async (context) => this.showStatus(context, false));
    this.bot.command('health', async (context) => this.showHealth(context, false));
    this.bot.command('accounts', async (context) => this.showAccountsMenu(context, false));
    this.bot.command('addaccount', async (context) => {
      const actorId = requireActorId(context);
      this.conversations.set(actorId, { step: 'awaiting_nickname' });
      await context.reply(
        'Send a unique nickname for the new account.',
        cancelKeyboard(),
      );
    });

    this.bot.command('account', async (context) => {
      await this.withAdminError(context, async () => {
        const accountKey = requireCommandAccountKey(context, 'account');
        await this.showAccountDetail(context, accountKey, false);
      });
    });

    this.bot.command('login', async (context) => {
      await this.withAdminError(context, async () => {
        const accountKey = requireCommandAccountKey(context, 'login');
        await this.beginLogin(context, accountKey, false);
      });
    });

    this.bot.command('code', async (context) => {
      await this.withSensitiveAdminError(context, async () => {
        const [accountKey, otp] = commandArguments(context);
        requireAccountKey(accountKey, 'Usage: /code <account-key> <otp>');
        requireArgument(otp, 'Usage: /code <account-key> <otp>');
        await deleteSensitiveMessage(context);
        const status = await this.requireController().submitOtp(accountKey, otp);
        await this.handleLoginStatus(context, status, false);
      });
    });

    this.bot.command('password', async (context) => {
      await this.withSensitiveAdminError(context, async () => {
        const [accountKey, ...passwordParts] = commandArguments(context);
        requireAccountKey(accountKey, 'Usage: /password <account-key> <2fa-password>');
        const password = passwordParts.join(' ');
        requireArgument(password, 'Usage: /password <account-key> <2fa-password>');
        await deleteSensitiveMessage(context);
        const status = await this.requireController().submitPassword(
          accountKey,
          password,
        );
        await this.handleLoginStatus(context, status, false);
      });
    });

    this.bot.command('cancellogin', async (context) => {
      await this.withAdminError(context, async () => {
        const accountKey = requireCommandAccountKey(context, 'cancellogin');
        await this.requireController().cancelLogin(accountKey);
        this.conversations.delete(context.from.id);
        await this.showAccountDetail(context, accountKey, false, '❌ Login cancelled.');
      });
    });

    this.registerLegacyAccountAction('reconnect', async (accountKey) => {
      await this.options.channelController?.stopAccountListeners(accountKey);
      await this.requireController().reconnect(accountKey);
      await this.options.channelController?.restartAccountListeners(accountKey);
    });
    this.registerLegacyAccountAction('disconnect', async (accountKey) => {
      await this.options.channelController?.stopAccountListeners(accountKey);
      await this.requireController().disconnect(accountKey);
    });
    this.registerLegacyAccountAction('enableaccount', async (accountKey) => {
      await this.requireController().enable(accountKey);
      await this.options.channelController?.restartAccountListeners(accountKey);
    });
    this.registerLegacyAccountAction('disableaccount', async (accountKey) => {
      await this.options.channelController?.stopAccountListeners(accountKey);
      await this.requireController().disable(accountKey);
    });

    this.bot.command('removeaccount', async (context) => {
      await this.withAdminError(context, async () => {
        const accountKey = requireCommandAccountKey(context, 'removeaccount');
        await this.showRemoveConfirmation(context, accountKey, false);
      });
    });
  }

  private registerLegacyAccountAction(
    command: string,
    action: (accountKey: string) => Promise<void>,
  ): void {
    this.bot.command(command, async (context) => {
      await this.withAdminError(context, async () => {
        const accountKey = requireCommandAccountKey(context, command);
        await action(accountKey);
        await this.showAccountDetail(context, accountKey, false);
      });
    });
  }

  private async handleNicknameInput(
    context: Context,
    rawNickname: string,
  ): Promise<void> {
    try {
      const nickname = this.requireController().validateNickname(rawNickname);
      this.conversations.set(requireActorId(context), {
        step: 'awaiting_phone',
        nickname,
      });
      await context.reply(
        [
          `Nickname: ${nickname}`,
          '',
          'Send the phone number in international format.',
          'Example: +628123456789',
        ].join('\n'),
        cancelKeyboard(),
      );
    } catch (error) {
      await context.reply(
        `Nickname rejected: ${errorReason(error)}`,
        cancelKeyboard(),
      );
    }
  }

  private async handlePhoneInput(
    context: Context,
    nickname: string,
    rawPhoneNumber: string,
  ): Promise<void> {
    const phoneNumber = rawPhoneNumber.trim();

    if (!PHONE_PATTERN.test(phoneNumber)) {
      await context.reply(
        'Invalid phone format. Send an international number such as +628123456789.',
        cancelKeyboard(),
      );
      return;
    }

    await deleteSensitiveMessage(context);
    await this.withSensitiveAdminError(context, async () => {
      const controller = this.requireController();
      const account = controller.addAccount({
        phoneNumber,
        label: nickname,
      });
      this.conversations.set(context.from?.id ?? 0, {
        step: 'starting_login',
        accountKey: account.accountKey,
      });
      await this.beginLogin(context, account.accountKey, false);
    });
  }

  private async handleRenameInput(
    context: Context,
    accountKey: string,
    rawNickname: string,
  ): Promise<void> {
    try {
      const controller = this.requireController();
      const nickname = controller.validateNickname(rawNickname, accountKey);
      controller.rename(accountKey, nickname);
      this.conversations.delete(requireActorId(context));
      await this.showAccountDetail(
        context,
        accountKey,
        false,
        '✅ Account renamed.',
      );
    } catch (error) {
      await context.reply(
        `Rename failed: ${errorReason(error)}`,
        cancelKeyboard(),
      );
    }
  }

  private async handleOtpInput(
    context: Context,
    accountKey: string,
    otp: string,
  ): Promise<void> {
    await deleteSensitiveMessage(context);
    await this.withSensitiveAdminError(context, async () => {
      const status = await this.requireController().submitOtp(accountKey, otp.trim());
      await this.handleLoginStatus(context, status, false);
    });
  }

  private async handlePasswordInput(
    context: Context,
    accountKey: string,
    password: string,
  ): Promise<void> {
    await deleteSensitiveMessage(context);
    await this.withSensitiveAdminError(context, async () => {
      const status = await this.requireController().submitPassword(accountKey, password);
      await this.handleLoginStatus(context, status, false);
    });
  }

  private async beginLogin(
    context: Context,
    accountKey: string,
    edit: boolean,
  ): Promise<void> {
    const actorId = requireActorId(context);
    this.conversations.set(actorId, { step: 'starting_login', accountKey });
    const status = await this.requireController().startLogin(accountKey);
    await this.handleLoginStatus(context, status, edit);
  }

  private async handleLoginStatus(
    context: Context,
    status: LoginStatus,
    edit: boolean,
  ): Promise<void> {
    const actorId = requireActorId(context);

    if (status.state === 'awaiting_otp') {
      this.conversations.set(actorId, {
        step: 'awaiting_otp',
        accountKey: status.accountKey,
      });
      await this.present(
        context,
        [
          '📨 OTP Requested',
          '',
          'Type the OTP sent by Telegram in this chat.',
          'The message will be deleted after it is read.',
        ].join('\n'),
        cancelKeyboard(),
        edit,
      );
      return;
    }

    if (status.state === 'awaiting_password') {
      this.conversations.set(actorId, {
        step: 'awaiting_password',
        accountKey: status.accountKey,
      });
      await this.present(
        context,
        [
          '🔐 Two-Factor Authentication',
          '',
          'Type the Telegram 2FA password in this chat.',
          'The message will be deleted after it is read.',
        ].join('\n'),
        cancelKeyboard(),
        edit,
      );
      return;
    }

    this.conversations.delete(actorId);
    const notice = status.state === 'authenticated'
      ? '✅ Login successful.'
      : `Login state: ${status.state}`;
    await this.showAccountDetail(context, status.accountKey, edit, notice);
  }

  private async cancelConversation(context: Context): Promise<void> {
    const actorId = requireActorId(context);
    const state = this.conversations.get(actorId);
    this.conversations.delete(actorId);

    if (
      state !== undefined &&
      (state.step === 'starting_login' ||
        state.step === 'awaiting_otp' ||
        state.step === 'awaiting_password')
    ) {
      await this.requireController().cancelLogin(state.accountKey).catch(() => undefined);
      await this.showAccountDetail(
        context,
        state.accountKey,
        true,
        '❌ Login cancelled.',
      );
      return;
    }

    if (state?.step === 'awaiting_rename') {
      await this.showAccountDetail(context, state.accountKey, true, '❌ Rename cancelled.');
      return;
    }

    if (
      state?.step === 'awaiting_channel_identifier' ||
      state?.step === 'awaiting_channel_account'
    ) {
      await this.showChannelsMenu(context, true, '❌ Add channel cancelled.');
      return;
    }

    if (
      state?.step === 'awaiting_global_triggers' ||
      state?.step === 'awaiting_global_excludes' ||
      state?.step === 'awaiting_global_cleanup'
    ) {
      await this.showRulesMenu(context, true, '❌ Configuration update cancelled.');
      return;
    }

    if (state?.step.startsWith('awaiting_rule_') === true) {
      await this.showRulesMenu(context, true, '❌ Rule flow cancelled.');
      return;
    }

    if (state?.step === 'awaiting_template_name' || state?.step === 'awaiting_template_body') {
      await this.showTemplatesMenu(
        context,
        state.accountKey,
        true,
        '❌ Template flow cancelled.',
      );
      return;
    }

    if (
      state?.step === 'awaiting_reply_delay' ||
      state?.step === 'awaiting_cooldown' ||
      state?.step === 'awaiting_hourly_limit' ||
      state?.step === 'awaiting_daily_limit' ||
      state?.step === 'awaiting_notification_target'
    ) {
      await this.showAccountAutomationSettings(
        context,
        state.accountKey,
        true,
        '❌ Settings update cancelled.',
      );
      return;
    }

    await this.showAccountsMenu(context, true, '❌ Add account cancelled.');
  }

  private async showMainMenu(
    context: Context,
    edit: boolean,
    notice?: string,
  ): Promise<void> {
    const automationEnabled = this.options.automationSafetyController?.getStatus().enabled;
    await this.present(
      context,
      [
        notice,
        'Auto WTB Bot Admin',
        '',
        `Automation: ${automationEnabled === false ? 'STOPPED' : 'RUNNING'}`,
        'Choose an option:',
      ].filter((line): line is string => line !== undefined).join('\n'),
      Markup.inlineKeyboard([
        [
          Markup.button.callback('👤 Accounts', 'm:accounts'),
          Markup.button.callback('📡 Channels', 'm:channels'),
        ],
        [
          Markup.button.callback('📋 Rules', 'm:rules'),
          Markup.button.callback('📝 Reply Templates', 'm:templates'),
        ],
        [
          Markup.button.callback('📊 Status', 'm:status'),
          Markup.button.callback('❤️ Health', 'm:health'),
        ],
        [Markup.button.callback('📋 Logs', 'm:logs')],
        [
          Markup.button.callback('🚨 STOP ALL', 'auto:stop'),
          Markup.button.callback('▶️ RESUME ALL', 'auto:resume'),
        ],
      ]),
      edit,
    );
  }

  private async showActionReports(context: Context, page: number, edit: boolean): Promise<void> {
    const size = 10;
    const safePage = Math.max(0, page);
    const reports = this.options.actionReportProvider?.listActionReports(
      this.options.ownerTelegramId,
      safePage * size,
      size,
    ) ?? [];
    const lines = reports.length === 0
      ? ['📋 Logs', '', 'No successful or failed Auto WTB actions yet.']
      : ['📋 Logs', '', ...reports.flatMap((report) => formatActionReport(report))];
    const navigation = [
      ...(safePage === 0 ? [] : [Markup.button.callback('⬅️ Prev', `l:page:${safePage - 1}`)]),
      ...(reports.length < size ? [] : [Markup.button.callback('Next ➡️', `l:page:${safePage + 1}`)]),
    ];
    await this.present(
      context,
      lines.join('\n'),
      Markup.inlineKeyboard([
        [...navigation, Markup.button.callback('🔄 Refresh', `l:page:${safePage}`)],
        [Markup.button.callback('⬅️ Back', 'm:main')],
      ]),
      edit,
    );
  }

  private async showAccountsMenu(
    context: Context,
    edit: boolean,
    notice?: string,
  ): Promise<void> {
    const controller = this.options.accountController;
    const accounts = controller?.listAccounts() ?? [];
    const accountRows = accounts.map((account) => [
      Markup.button.callback(
        `⚙️ Manage ${truncateLabel(account.nickname)} · ${statusIcon(account.status)}`,
        `a:o:${account.accountKey}`,
      ),
    ]);
    const keyboard = Markup.inlineKeyboard([
      ...accountRows,
      [Markup.button.callback('➕ Add Account', 'a:add')],
      [
        Markup.button.callback('🔄 Refresh', 'm:accounts'),
        Markup.button.callback('⬅️ Back', 'm:main'),
      ],
    ]);
    const text = [
      notice,
      '👤 Telegram Accounts',
      '',
      controller === undefined
        ? 'Account management is unavailable.'
        : accounts.length === 0
          ? 'No accounts registered yet.'
          : `${accounts.length} account(s) registered.`,
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n');

    await this.present(context, text, keyboard, edit);
  }

  private async showAccountDetail(
    context: Context,
    accountKey: string,
    edit: boolean,
    notice?: string,
  ): Promise<void> {
    const controller = this.requireController();
    const account = controller.getAccount(accountKey);
    const login = controller.getLoginStatus(accountKey);
    const text = [
      notice,
      '👤 Account Detail',
      '',
      formatAccount(account),
      login === undefined ? undefined : `Login: ${login.state}`,
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n');

    await this.present(context, text, accountDetailKeyboard(accountKey), edit);
  }

  private async showAccountAutomationSettings(
    context: Context,
    accountKey: string,
    edit: boolean,
    notice?: string,
  ): Promise<void> {
    const settings = this.requireAutomationSettingsController().get(accountKey);
    await this.present(
      context,
      [
        notice,
        '⚙️ Auto Reply Settings',
        '',
        `Account: ${settings.accountNickname}`,
        `Reply delay: ${formatMilliseconds(settings.replyDelayMs)}`,
        `Auto Reaction ❤️: ${settings.autoReaction ? 'ON' : 'OFF'}`,
        `Cooldown: ${formatMilliseconds(settings.cooldownMs)}`,
        `Hourly limit: ${settings.hourlyLimit === 0 ? 'unlimited' : settings.hourlyLimit}`,
        `Daily limit: ${settings.dailyLimit === 0 ? 'unlimited' : settings.dailyLimit}`,
        `Notification bot: ${settings.notificationTarget ?? 'not configured'}`,
      ].filter((line): line is string => line !== undefined).join('\n'),
      Markup.inlineKeyboard([
        [Markup.button.callback('📬 Notification Bot', `a:notify:${accountKey}`)],
        [Markup.button.callback('⏱ Reply Delay', `a:delay:${accountKey}`)],
        [Markup.button.callback('❤️ Auto Reaction', `a:reaction:${accountKey}`)],
        [Markup.button.callback('⏳ Cooldown', `a:cool:${accountKey}`)],
        [Markup.button.callback('📊 Limits', `a:limits:${accountKey}`)],
        [
          Markup.button.callback('🔄 Refresh', `a:auto:${accountKey}`),
          Markup.button.callback('⬅️ Back', `a:o:${accountKey}`),
        ],
      ]),
      edit,
    );
  }

  private async showReactionSettings(
    context: Context,
    accountKey: string,
    edit: boolean,
    notice?: string,
  ): Promise<void> {
    const settings = this.requireAutomationSettingsController().get(accountKey);
    await this.present(
      context,
      [
        notice,
        '❤️ Auto Reaction',
        '',
        `Account: ${settings.accountNickname}`,
        `Status: ${settings.autoReaction ? 'ON' : 'OFF'}`,
        'Reaction failure never changes a successful reply into a failure.',
      ].filter((line): line is string => line !== undefined).join('\n'),
      Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ ON', `a:re:on:${accountKey}`),
          Markup.button.callback('⏸ OFF', `a:re:off:${accountKey}`),
        ],
        [Markup.button.callback('⬅️ Back', `a:auto:${accountKey}`)],
      ]),
      edit,
    );
  }

  private async showAccountLimits(
    context: Context,
    accountKey: string,
    edit: boolean,
  ): Promise<void> {
    const settings = this.requireAutomationSettingsController().get(accountKey);
    await this.present(
      context,
      [
        '📊 Reply Limits',
        '',
        `Account: ${settings.accountNickname}`,
        `Hourly: ${settings.hourlyLimit === 0 ? 'unlimited' : settings.hourlyLimit}`,
        `Daily: ${settings.dailyLimit === 0 ? 'unlimited' : settings.dailyLimit}`,
      ].join('\n'),
      Markup.inlineKeyboard([
        [Markup.button.callback('Edit Hourly Limit', `a:hour:${accountKey}`)],
        [Markup.button.callback('Edit Daily Limit', `a:day:${accountKey}`)],
        [
          Markup.button.callback('🔄 Refresh', `a:limits:${accountKey}`),
          Markup.button.callback('⬅️ Back', `a:auto:${accountKey}`),
        ],
      ]),
      edit,
    );
  }

  private async showChannelsMenu(
    context: Context,
    edit: boolean,
    notice?: string,
  ): Promise<void> {
    const controller = this.options.channelController;
    const channels = controller?.listChannels() ?? [];
    const text = [
      notice,
      '📡 Channels',
      '',
      controller === undefined
        ? 'Channel management is unavailable.'
        : channels.length === 0
          ? 'No channels saved yet.'
          : `${channels.length} independent channel(s).`,
    ].filter((item): item is string => item !== undefined).join('\n');
    await this.present(
      context,
      text,
      Markup.inlineKeyboard([
        ...channels.map((channel) => [Markup.button.callback(
          `⚙️ ${truncateLabel(channel.title)} · ${channel.enabled ? '🟢' : '⏸'}`,
          `c:o:${channel.id}`,
        )]),
        [Markup.button.callback('➕ Add Channel', 'c:add')],
        [
          Markup.button.callback('🔄 Refresh', 'm:channels'),
          Markup.button.callback('⬅️ Back', 'm:main'),
        ],
      ]),
      edit,
    );
  }

  private async showChannelDetail(
    context: Context,
    channelId: number,
    edit: boolean,
    notice?: string,
  ): Promise<void> {
    const detail = this.requireChannelController().getChannel(channelId);
    const channel = detail.channel;
    await this.present(
      context,
      [
        notice,
        '📡 Channel Detail',
        '',
        `Title: ${channel.title}`,
        `Username: ${channel.username === undefined ? '—' : `@${channel.username.replace(/^@/, '')}`}`,
        `Telegram ID: ${channel.telegramChannelId}`,
        `Status: ${channel.status}`,
        `Enabled: ${channel.enabled ? 'yes' : 'no'}`,
        `Automation: ${channel.automationBlocked === true ? '🚫 BLOCKED' : 'active'}`,
        channel.blockedReason === undefined ? undefined : `Blocked reason: ${channel.blockedReason}`,
        `Monitoring accounts: ${detail.assignments.length}`,
      ].filter((item): item is string => item !== undefined).join('\n'),
      Markup.inlineKeyboard([
        [Markup.button.callback('👥 Monitoring Accounts', `c:ac:${channelId}`)],
        ...(channel.automationBlocked === true
          ? [[Markup.button.callback('▶️ Resume', `c:resume:${channelId}`)]]
          : []),
        [
          Markup.button.callback('▶️ Enable', `c:en:${channelId}`),
          Markup.button.callback('⏸ Disable', `c:di:${channelId}`),
        ],
        [Markup.button.callback('🗑 Remove', `c:rm:${channelId}`)],
        [
          Markup.button.callback('🔄 Refresh', `c:o:${channelId}`),
          Markup.button.callback('⬅️ Back', 'm:channels'),
        ],
      ]),
      edit,
    );
  }

  private async showRulesMenu(
    context: Context,
    edit: boolean,
    notice?: string,
  ): Promise<void> {
    const controller = this.options.ruleController;
    const rules = controller?.list() ?? [];
    const configuration = this.options.keywordController?.getConfiguration();
    await this.present(
      context,
      [
        notice,
        '📋 Rules',
        '',
        controller === undefined
          ? 'Rule management is unavailable.'
          : rules.length === 0
            ? 'No rules configured yet.'
            : `${rules.length} channel-scoped rule(s).`,
        `Global config: ${configuration?.enabled === false ? 'disabled' : 'enabled'}`,
      ].filter((item): item is string => item !== undefined).join('\n'),
      Markup.inlineKeyboard([
        [
          Markup.button.callback('🎯 Trigger Keywords', 'g:tr'),
          Markup.button.callback('🚫 Exclude Keywords', 'g:ex'),
        ],
        [Markup.button.callback('🧹 Cleanup Patterns', 'g:cl')],
        [Markup.button.callback('💬 Reply Templates', 'm:templates')],
        [Markup.button.callback('⚙️ Settings / Status', 'g:st')],
        ...rules.map((rule) => [Markup.button.callback(
          `${rule.enabled ? '✅' : '⏸'} ${truncateLabel(rule.name)}`,
          `r:o:${rule.id}`,
        )]),
        [Markup.button.callback('➕ Add Rule', 'r:add')],
        [
          Markup.button.callback('🔄 Refresh', 'm:rules'),
          Markup.button.callback('⬅️ Back', 'm:main'),
        ],
      ]),
      edit,
    );
  }

  private async showRuleSettings(
    context: Context,
    edit: boolean,
    notice?: string,
  ): Promise<void> {
    const configuration = this.requireKeywordController().getConfiguration();
    const status = this.options.statusProvider();
    await this.present(
      context,
      [
        notice,
        '⚙️ Rules Settings / Status',
        '',
        `Global detection: ${configuration.enabled ? 'enabled' : 'disabled'}`,
        `Trigger keywords: ${configuration.triggerKeywords.length}`,
        `Exclude keywords: ${configuration.excludeKeywords.length}`,
        `Cleanup patterns: ${configuration.cleanupPatterns.length}`,
        `Configured rules: ${this.options.ruleController?.list().length ?? 0}`,
        `Runtime: ${status.state}`,
        `Connected accounts: ${status.connectedTelegramClients}/${status.registeredTelegramClients}`,
        '',
        'Detection remains limited to Telegram channel posts.',
      ].filter((item): item is string => item !== undefined).join('\n'),
      Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Enable', 'g:en'),
          Markup.button.callback('⏸ Disable', 'g:di'),
        ],
        [
          Markup.button.callback('🔄 Refresh', 'g:st'),
          Markup.button.callback('⬅️ Back', 'm:rules'),
        ],
      ]),
      edit,
    );
  }

  private async showRuleDetail(
    context: Context,
    ruleId: number,
    edit: boolean,
    notice?: string,
  ): Promise<void> {
    const rule = this.requireRuleController().get(ruleId);
    await this.present(
      context,
      [
        notice,
        '📋 Rule Detail',
        '',
        `Name: ${rule.name}`,
        `Channel: ${rule.channelTitle}`,
        `Status: ${rule.enabled ? 'enabled' : 'disabled'}`,
        `Triggers: ${formatValues(rule.triggerKeywords)}`,
        `Excludes: ${formatValues(rule.excludeKeywords)}`,
        `Cleanup sender: ${formatValues(rule.cleanupSenderPatterns)}`,
        `Reply template: ${rule.replyTemplateName ?? 'none'}`,
        rule.replyTemplateAccountNickname === undefined
          ? undefined
          : `Template account: ${rule.replyTemplateAccountNickname}`,
        '',
        'Execution remains channel-post only. M5 may use the linked template through its owning account.',
      ].filter((item): item is string => item !== undefined).join('\n'),
      Markup.inlineKeyboard([
        [Markup.button.callback('✏️ Edit', `r:ed:${rule.id}`)],
        [
          Markup.button.callback('✅ Enable', `r:en:${rule.id}`),
          Markup.button.callback('⏸ Disable', `r:di:${rule.id}`),
        ],
        [Markup.button.callback('🗑 Delete', `r:rm:${rule.id}`)],
        [
          Markup.button.callback('🔄 Refresh', `r:o:${rule.id}`),
          Markup.button.callback('⬅️ Back', 'm:rules'),
        ],
      ]),
      edit,
    );
  }

  private async showTemplateAccountPicker(
    context: Context,
    edit: boolean,
    notice?: string,
  ): Promise<void> {
    const accounts = this.options.accountController?.listAccounts() ?? [];
    await this.present(
      context,
      [
        notice,
        '💬 Reply Templates',
        '',
        accounts.length === 0
          ? 'Add an account before managing reply templates.'
          : 'Choose the Telegram account that owns the templates.',
      ].filter((item): item is string => item !== undefined).join('\n'),
      Markup.inlineKeyboard([
        ...accounts.map((account) => [Markup.button.callback(
          `👤 ${truncateLabel(account.nickname)}`,
          `t:list:${account.accountKey}`,
        )]),
        [Markup.button.callback('⬅️ Back', 'm:rules')],
      ]),
      edit,
    );
  }

  private async showTemplatesMenu(
    context: Context,
    accountKey: string,
    edit: boolean,
    notice?: string,
  ): Promise<void> {
    const account = this.requireController().getAccount(accountKey);
    const templates = this.requireTemplateController().list(accountKey);
    await this.present(
      context,
      [
        notice,
        '💬 Reply Templates',
        '',
        `Account: ${account.nickname}`,
        templates.length === 0
          ? 'No reply templates for this account.'
          : `${templates.length} template(s).`,
      ].filter((item): item is string => item !== undefined).join('\n'),
      Markup.inlineKeyboard([
        ...templates.map((template) => [Markup.button.callback(
          `${template.enabled ? '🟢' : '⏸'} ${truncateLabel(template.name)}`,
          `t:o:${accountKey}:${template.id}`,
        )]),
        [Markup.button.callback('➕ Add Template', `t:add:${accountKey}`)],
        [
          Markup.button.callback('🔄 Refresh', `t:list:${accountKey}`),
          Markup.button.callback('⬅️ Back', `a:o:${accountKey}`),
        ],
      ]),
      edit,
    );
  }

  private async showTemplateDetail(
    context: Context,
    accountKey: string,
    templateId: number,
    edit: boolean,
    notice?: string,
  ): Promise<void> {
    const template = this.requireTemplateController().get(accountKey, templateId);
    await this.present(
      context,
      [
        notice,
        '💬 Reply Template',
        '',
        `Account: ${template.accountNickname}`,
        `Name: ${template.name}`,
        `Status: ${template.enabled ? 'enabled' : 'disabled'}`,
        '',
        template.body,
        '',
        'M5 may send this template only through its owning account.',
      ].filter((item): item is string => item !== undefined).join('\n'),
      Markup.inlineKeyboard([
        [Markup.button.callback('✏️ Edit', `t:ed:${accountKey}:${template.id}`)],
        [
          Markup.button.callback('✅ Enable', `t:en:${accountKey}:${template.id}`),
          Markup.button.callback('⏸ Disable', `t:di:${accountKey}:${template.id}`),
        ],
        [Markup.button.callback('🗑 Delete', `t:rm:${accountKey}:${template.id}`)],
        [
          Markup.button.callback('🔄 Refresh', `t:o:${accountKey}:${template.id}`),
          Markup.button.callback('⬅️ Back', `t:list:${accountKey}`),
        ],
      ]),
      edit,
    );
  }

  private async showChannelAccounts(
    context: Context,
    channelId: number,
    edit: boolean,
    notice?: string,
  ): Promise<void> {
    const controller = this.requireChannelController();
    const detail = controller.getChannel(channelId);
    const assignments = new Map(
      detail.assignments.map((assignment) => [assignment.accountId, assignment]),
    );
    const rows = controller.listAccounts().map((account) => {
      const assignment = assignments.get(account.id);
      if (assignment === undefined) {
        return [Markup.button.callback(
          `➕ ${truncateLabel(account.nickname)}`,
          `c:as:${channelId}:${account.id}`,
        )];
      }
      return [
        Markup.button.callback(
          `➖ ${truncateLabel(account.nickname)}`,
          `c:un:${channelId}:${assignment.id}`,
        ),
        Markup.button.callback(
          assignment.enabled ? '⏸' : '▶️',
          `${assignment.enabled ? 'c:ad' : 'c:ae'}:${channelId}:${assignment.id}`,
        ),
      ];
    });
    await this.present(
      context,
      [notice, '👥 Monitoring Accounts', '', detail.channel.title,
        'Assign/unassign only affects this channel relationship.']
        .filter((item): item is string => item !== undefined).join('\n'),
      Markup.inlineKeyboard([
        ...rows,
        [
          Markup.button.callback('🔄 Refresh', `c:ac:${channelId}`),
          Markup.button.callback('⬅️ Back', `c:o:${channelId}`),
        ],
      ]),
      edit,
    );
  }

  private async showAccountChannels(
    context: Context,
    accountKey: string,
    edit: boolean,
  ): Promise<void> {
    const account = this.requireController().getAccount(accountKey);
    const entries = this.requireChannelController().listAccountChannels(accountKey);
    await this.present(
      context,
      ['📡 Monitoring Channels', '', account.nickname,
        entries.length === 0 ? 'No channel assignments.' : `${entries.length} assigned channel(s).`]
        .join('\n'),
      Markup.inlineKeyboard([
        ...entries.map(({ channel, assignment }) => [Markup.button.callback(
          `${assignment.enabled ? '🟢' : '⏸'} ${truncateLabel(channel.title)}`,
          `c:o:${channel.id}`,
        )]),
        [
          Markup.button.callback('🔄 Refresh', `a:ch:${accountKey}`),
          Markup.button.callback('⬅️ Back', `a:o:${accountKey}`),
        ],
      ]),
      edit,
    );
  }

  private async showRemoveConfirmation(
    context: Context,
    accountKey: string,
    edit: boolean,
  ): Promise<void> {
    const account = this.requireController().getAccount(accountKey);
    await this.present(
      context,
      [
        '⚠️ Remove Account?',
        '',
        account.nickname,
        maskPhone(account.phoneNumber),
        '',
        'The isolated Telegram session for this account will also be removed.',
      ].join('\n'),
      Markup.inlineKeyboard([
        [
          Markup.button.callback('⚠️ Yes, Remove', `a:yes:${accountKey}`),
          Markup.button.callback('❌ Cancel', `a:no:${accountKey}`),
        ],
      ]),
      edit,
    );
  }

  private async showStatus(context: Context, edit: boolean): Promise<void> {
    const status = this.options.statusProvider();
    const automation = this.options.automationSafetyController?.getStatus();
    await this.present(
      context,
      [
        '📊 Auto WTB Bot Status',
        '',
        `Runtime: ${status.state}`,
        `Uptime: ${status.uptimeSeconds}s`,
        `Database migration: v${status.migrationVersion}`,
        `Telegram clients: ${status.connectedTelegramClients}/${status.registeredTelegramClients}`,
        `Automation: ${automation?.enabled === false ? 'STOPPED' : 'RUNNING'}`,
      ].join('\n'),
      backToMainKeyboard(),
      edit,
    );
  }

  private async showHealth(context: Context, edit: boolean): Promise<void> {
    const status = this.options.statusProvider();
    const healthy = status.state === 'running';
    await this.present(
      context,
      [
        `${healthy ? '❤️' : '⚠️'} Health`,
        '',
        `Runtime: ${healthy ? 'healthy' : status.state}`,
        `Database: migration v${status.migrationVersion}`,
        `Clients connected: ${status.connectedTelegramClients}`,
      ].join('\n'),
      backToMainKeyboard(),
      edit,
    );
  }

  private async present(
    context: Context,
    text: string,
    keyboard: ReturnType<typeof Markup.inlineKeyboard>,
    edit: boolean,
  ): Promise<void> {
    if (edit) {
      try {
        await context.editMessageText(text, keyboard);
        return;
      } catch (error) {
        if (errorReason(error).toLowerCase().includes('message is not modified')) {
          return;
        }
      }
    }

    await context.reply(text, keyboard);
  }

  private requireController(): AdminAccountController {
    if (this.options.accountController === undefined) {
      throw new Error('Account management is unavailable');
    }

    return this.options.accountController;
  }

  private requireChannelController(): AdminChannelController {
    if (this.options.channelController === undefined) {
      throw new Error('Channel management is unavailable');
    }
    return this.options.channelController;
  }

  private requireRuleController(): AdminRuleController {
    if (this.options.ruleController === undefined) throw new Error('Rule management is unavailable');
    return this.options.ruleController;
  }

  private requireTemplateController(): AdminReplyTemplateController {
    if (this.options.replyTemplateController === undefined) {
      throw new Error('Reply template management is unavailable');
    }
    return this.options.replyTemplateController;
  }

  private requireKeywordController(): AdminGlobalKeywordController {
    if (this.options.keywordController === undefined) {
      throw new Error('Global keyword configuration is unavailable');
    }
    return this.options.keywordController;
  }

  private requireAutomationSettingsController(): AdminAccountAutomationController {
    if (this.options.automationSettingsController === undefined) {
      throw new Error('Account auto reply settings are unavailable');
    }
    return this.options.automationSettingsController;
  }

  private requireAutomationSafetyController(): AdminAutomationSafetyController {
    if (this.options.automationSafetyController === undefined) {
      throw new Error('Automation safety controls are unavailable');
    }
    return this.options.automationSafetyController;
  }

  private async withAdminError(
    context: Context,
    operation: () => Promise<void>,
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      await context.reply(`Operation failed: ${errorReason(error)}`, backToMainKeyboard());
    }
  }

  private async withSensitiveAdminError(
    context: Context,
    operation: () => Promise<void>,
  ): Promise<void> {
    try {
      await operation();
    } catch {
      await deleteSensitiveMessage(context);
      await context.reply(
        'Login input was rejected. Check the value and try again, or cancel.',
        cancelKeyboard(),
      );
    }
  }
}

function accountDetailKeyboard(accountKey: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔐 Login', `a:li:${accountKey}`)],
    [Markup.button.callback('📡 Monitoring Channels', `a:ch:${accountKey}`)],
    [Markup.button.callback('💬 Reply Templates', `a:tp:${accountKey}`)],
    [
      Markup.button.callback('⏱ Reply Delay', `a:delay:${accountKey}`),
      Markup.button.callback('❤️ Auto Reaction', `a:reaction:${accountKey}`),
    ],
    [Markup.button.callback('⚙️ Auto Reply Settings', `a:auto:${accountKey}`)],
    [Markup.button.callback('📊 Limits', `a:limits:${accountKey}`)],
    [
      Markup.button.callback('🔄 Reconnect', `a:rc:${accountKey}`),
      Markup.button.callback('🔌 Disconnect', `a:dc:${accountKey}`),
    ],
    [
      Markup.button.callback('▶️ Enable', `a:en:${accountKey}`),
      Markup.button.callback('⏸ Disable', `a:di:${accountKey}`),
    ],
    [
      Markup.button.callback('✏️ Rename', `a:rn:${accountKey}`),
      Markup.button.callback('🗑 Remove', `a:rm:${accountKey}`),
    ],
    [Markup.button.callback('⬅️ Back', 'm:accounts')],
  ]);
}

function callbackNumbers(context: Context): number[] {
  const callbackQuery = context.callbackQuery;
  const data = callbackQuery !== undefined && 'data' in callbackQuery
    ? callbackQuery.data
    : '';
  const values = data.split(':').filter((part) => /^\d+$/.test(part)).map(Number);
  if (values.length === 0 || values.some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new Error('Invalid callback identifier');
  }
  return values;
}

function callbackData(context: Context): string {
  const callbackQuery = context.callbackQuery;
  return callbackQuery !== undefined && 'data' in callbackQuery ? callbackQuery.data : '';
}

function callbackNumber(context: Context): number {
  const value = callbackNumbers(context).at(-1);
  if (value === undefined) throw new Error('Invalid callback identifier');
  return value;
}

function callbackPair(context: Context): [number, number] {
  const values = callbackNumbers(context);
  const first = values.at(-2);
  const second = values.at(-1);
  if (first === undefined || second === undefined) {
    throw new Error('Invalid callback identifiers');
  }
  return [first, second];
}

function parseAdminValues(value: string): string[] {
  if (value.trim() === '-') return [];
  return value.split(/[\n,]/).map((item) => item.trim()).filter((item) => item.length > 0);
}

function formatValues(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.join(', ');
}

function formatMilliseconds(milliseconds: number): string {
  return `${Number((milliseconds / 1_000).toFixed(3))}s`;
}

function typeLabel(type: 'trigger' | 'exclude' | 'cleanup'): string {
  if (type === 'trigger') return 'Trigger keywords';
  if (type === 'exclude') return 'Exclude keywords';
  return 'Cleanup patterns';
}

function cancelKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel', 'flow:cancel')],
  ]);
}

function backToMainKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⬅️ Back', 'm:main')],
  ]);
}

function commandArguments(context: Context): string[] {
  const message = context.message;

  if (message === undefined || !('text' in message)) {
    return [];
  }

  return message.text.trim().split(/\s+/).slice(1);
}

function requireCommandAccountKey(context: Context, command: string): string {
  const [accountKey] = commandArguments(context);
  requireAccountKey(accountKey, `Usage: /${command} <account-key>`);
  return accountKey;
}

function requireCallbackAccountKey(context: Context): string {
  const callbackQuery = context.callbackQuery;
  const data = callbackQuery !== undefined && 'data' in callbackQuery
    ? callbackQuery.data
    : undefined;
  const accountKey = data?.split(':').at(-1);
  requireAccountKey(accountKey, 'Invalid account callback');
  return accountKey;
}

function requireTemplateCallback(context: Context): {
  accountKey: string;
  templateId: number;
} {
  const callbackQuery = context.callbackQuery;
  const data = callbackQuery !== undefined && 'data' in callbackQuery
    ? callbackQuery.data
    : '';
  const parts = data.split(':');
  const accountKey = parts.at(-2);
  const rawTemplateId = parts.at(-1);
  requireAccountKey(accountKey, 'Invalid reply template account callback');
  const templateId = Number(rawTemplateId);
  if (!Number.isSafeInteger(templateId) || templateId < 1) {
    throw new Error('Invalid reply template callback');
  }
  return { accountKey, templateId };
}

function requireAccountKey(
  accountKey: string | undefined,
  message: string,
): asserts accountKey is string {
  if (accountKey === undefined || !ACCOUNT_KEY_PATTERN.test(accountKey)) {
    throw new Error(message);
  }
}

function requireArgument(
  value: string | undefined,
  usage: string,
): asserts value is string {
  if (value === undefined || value.length === 0) {
    throw new Error(usage);
  }
}

function requireActorId(context: Context): number {
  const actorId = context.from?.id;

  if (actorId === undefined) {
    throw new Error('Telegram actor is unavailable');
  }

  return actorId;
}

function formatAccount(account: AccountRecord): string {
  return [
    `Nickname: ${account.nickname}`,
    `ID: ${account.accountKey}`,
    `Phone: ${maskPhone(account.phoneNumber)}`,
    `Status: ${account.status}`,
    `Enabled: ${account.enabled ? 'yes' : 'no'}`,
  ].join('\n');
}

function maskPhone(phoneNumber: string): string {
  return phoneNumber.length <= 6
    ? '***'
    : `${phoneNumber.slice(0, 4)}***${phoneNumber.slice(-3)}`;
}

function truncateLabel(label: string): string {
  return label.length <= 24 ? label : `${label.slice(0, 21)}...`;
}

function statusIcon(status: AccountRecord['status']): string {
  if (status === 'connected') return '🟢';
  if (status === 'error') return '🔴';
  if (status === 'connecting') return '🟡';
  return '⚪';
}

function formatActionReport(report: ActionReportRecord): string[] {
  const sourceMessageId = report.metadata.sourceMessageId;
  const trigger = report.metadata.trigger;
  const reactionStatus = report.metadata.reactionStatus;
  return [
    `${report.eventType === 'reply_sent' ? '✅ SUCCESS' : '❌ FAILED'} · ${report.createdAt}`,
    `Account: ${report.accountNickname}`,
    `Channel: ${report.channelTitle}`,
    ...(typeof trigger === 'string' ? [`Trigger: ${trigger}`] : []),
    ...(typeof sourceMessageId === 'number' ? [`Source: #${sourceMessageId}`] : []),
    `Action: ${report.eventType === 'reply_sent' ? 'Reply sent' : 'Reply failed'}`,
    ...(typeof reactionStatus === 'string' ? [`Reaction: ${reactionStatus}`] : []),
    ...(report.reason === undefined ? [] : [`Reason: ${report.reason}`]),
    '',
  ];
}

async function acknowledgeCallback(context: Context): Promise<void> {
  await context.answerCbQuery().catch(() => undefined);
}

async function deleteSensitiveMessage(context: Context): Promise<void> {
  await context.deleteMessage().catch(() => undefined);
}

function waitForAdminLifecycleTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}
