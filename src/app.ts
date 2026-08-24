import { AdminBotService } from './admin-bot/admin-bot.service.js';
import { AccountAutomationSettingsRepository } from './automation/account-automation-settings.repository.js';
import { AccountAutomationSettingsService } from './automation/account-automation-settings.service.js';
import { AutomationDispatchRepository } from './automation/automation-dispatch.repository.js';
import { AutomationSafetyService } from './automation/automation-safety.service.js';
import { AutoReplyService } from './automation/auto-reply.service.js';
import type { OwnerNotificationGateway } from './automation/automation.types.js';
import {
  GramJsAccountNotificationGateway,
  GramJsAutoReplyGateway,
} from './automation/gramjs-auto-reply.gateway.js';
import { AccountManagerService } from './accounts/account-manager.service.js';
import { AccountRepository } from './accounts/account.repository.js';
import { AccountService } from './accounts/account.service.js';
import { AccountSessionStore } from './accounts/session-store.js';
import type { AppConfig } from './config/config.js';
import { ChannelListenerService } from './channels/channel-listener.service.js';
import { ChannelRepository } from './channels/channel.repository.js';
import { ChannelService } from './channels/channel.service.js';
import { GramJsChannelGateway } from './channels/gramjs-channel.gateway.js';
import { DatabaseService } from './database/database.service.js';
import { EventLogRepository } from './logging/event-log.repository.js';
import {
  createLogger,
  errorReason,
  type LoggerHandle,
} from './logging/logger.js';
import { ensureStorageDirectories, type StoragePaths } from './storage/storage.js';
import { DetectionService } from './rules/detection.service.js';
import { DetectionPipelineService } from './rules/detection-pipeline.service.js';
import { GlobalDetectionService } from './rules/global-detection.service.js';
import { GlobalKeywordService } from './rules/global-keyword.service.js';
import { ReplyTemplateRepository } from './rules/reply-template.repository.js';
import { ReplyTemplateService } from './rules/reply-template.service.js';
import { RuleRepository } from './rules/rule.repository.js';
import { RuleService } from './rules/rule.service.js';
import { TelegramClientRegistry } from './user-client/telegram-client.registry.js';

export type ApplicationState =
  | 'created'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed';

export interface ApplicationStatus {
  readonly service: 'auto-wtb-bot';
  readonly milestone: 'M6';
  readonly state: ApplicationState;
  readonly uptimeSeconds: number;
  readonly migrationVersion: number;
  readonly adminBotEnabled: boolean;
  readonly adminBotRunning: boolean;
  readonly registeredTelegramClients: number;
  readonly connectedTelegramClients: number;
}

export class AutoWtbApplication {
  private state: ApplicationState = 'created';
  private startedAt?: number;
  private storagePaths?: StoragePaths;
  private loggerHandle?: LoggerHandle;
  private database?: DatabaseService;
  private adminBot?: AdminBotService;
  private telegramClients?: TelegramClientRegistry;
  private accountManager?: AccountManagerService;
  private channelService?: ChannelService;
  private ruleService?: RuleService;
  private replyTemplateService?: ReplyTemplateService;
  private globalKeywords?: GlobalKeywordService;
  private automationSettings?: AccountAutomationSettingsService;
  private automationSafety?: AutomationSafetyService;
  private autoReply?: AutoReplyService;
  private keepAliveTimer: NodeJS.Timeout | undefined;
  private shutdownPromise?: Promise<void>;
  private readonly stoppedPromise: Promise<void>;
  private resolveStopped!: () => void;

  public constructor(private readonly config: AppConfig) {
    this.stoppedPromise = new Promise((resolve) => {
      this.resolveStopped = resolve;
    });
  }

  public async start(): Promise<void> {
    if (this.state !== 'created') {
      throw new Error(`Application cannot start from state ${this.state}`);
    }

    this.state = 'starting';

    try {
      let shouldStartListeners = false;
      this.storagePaths = ensureStorageDirectories(this.config.storage);
      this.loggerHandle = createLogger({
        level: this.config.logLevel,
        logDirectory: this.storagePaths.logDirectory,
        environment: this.config.environment,
      });
      this.telegramClients = new TelegramClientRegistry(this.loggerHandle.logger);

      this.loggerHandle.logger.info(
        { action: 'application_start', status: 'starting' },
        'Auto WTB Bot startup started',
      );

      this.database = new DatabaseService(
        this.storagePaths.databasePath,
        this.loggerHandle.logger,
      );
      this.database.initialize();

      if (this.config.adminBot.ownerTelegramId !== undefined) {
        this.database.ensureOwner(this.config.adminBot.ownerTelegramId);
        const accountRepository = new AccountRepository(this.database.getConnection());
        const accountService = new AccountService(
          accountRepository,
          this.config.adminBot.ownerTelegramId,
          this.loggerHandle.logger,
        );
        const sessionStore = new AccountSessionStore(this.storagePaths.sessionDirectory);
        this.accountManager = new AccountManagerService(
          accountService,
          sessionStore,
          this.telegramClients,
          this.loggerHandle.logger,
          {
            loginTimeoutMs: this.config.loginTimeoutMs,
            ...(this.config.telegram.apiId === undefined
              ? {}
              : { apiId: this.config.telegram.apiId }),
            ...(this.config.telegram.apiHash === undefined
              ? {}
              : { apiHash: this.config.telegram.apiHash }),
          },
        );

        const channelRepository = new ChannelRepository(this.database.getConnection());
        const channelGateway = new GramJsChannelGateway(accountService, this.telegramClients);
        const eventLogs = new EventLogRepository(this.database.getConnection());
        const templateRepository = new ReplyTemplateRepository(this.database.getConnection());
        this.replyTemplateService = new ReplyTemplateService(
          templateRepository,
          this.config.adminBot.ownerTelegramId,
          this.loggerHandle.logger,
        );
        const ruleRepository = new RuleRepository(this.database.getConnection());
        this.ruleService = new RuleService(
          ruleRepository,
          channelRepository,
          this.replyTemplateService,
          eventLogs,
          this.config.adminBot.ownerTelegramId,
          this.loggerHandle.logger,
        );
        const detectionService = new DetectionService(
          ruleRepository,
          eventLogs,
          this.loggerHandle.logger,
        );
        this.globalKeywords = new GlobalKeywordService(
          this.database.getConnection(),
          this.loggerHandle.logger,
        );
        const globalDetection = new GlobalDetectionService(
          this.globalKeywords,
          eventLogs,
          this.loggerHandle.logger,
        );
        const channelListeners = new ChannelListenerService(
          channelRepository,
          channelGateway,
          this.loggerHandle.logger,
        );
        this.channelService = new ChannelService(
          channelRepository,
          accountService,
          this.config.adminBot.ownerTelegramId,
          channelGateway,
          channelListeners,
          this.loggerHandle.logger,
        );
        this.automationSafety = new AutomationSafetyService(
          this.database.getConnection(),
          this.channelService,
          eventLogs,
          this.loggerHandle.logger,
        );
        this.automationSettings = new AccountAutomationSettingsService(
          new AccountAutomationSettingsRepository(this.database.getConnection()),
          this.config.adminBot.ownerTelegramId,
          this.loggerHandle.logger,
        );
        const detectionPipeline = new DetectionPipelineService(
          globalDetection,
          detectionService,
        );
        const safetyNotifications: OwnerNotificationGateway = {
          notify: (notification) => this.adminBot?.notifyOwner(notification) ?? Promise.resolve(false),
        };
        const autoReply = new AutoReplyService(
          detectionPipeline,
          this.automationSafety,
          channelRepository,
          ruleRepository,
          this.replyTemplateService,
          this.automationSettings,
          new AutomationDispatchRepository(this.database.getConnection()),
          new GramJsAutoReplyGateway(accountService, this.telegramClients),
          new GramJsAccountNotificationGateway(
            accountService,
            this.telegramClients,
            this.automationSettings,
          ),
          safetyNotifications,
          eventLogs,
          this.config.adminBot.ownerTelegramId,
          this.loggerHandle.logger,
        );
        this.autoReply = autoReply;
        channelListeners.setProcessor(autoReply);

        if (
          this.config.telegram.apiId !== undefined &&
          this.config.telegram.apiHash !== undefined
        ) {
          await this.accountManager.restoreEnabledAccounts();
          shouldStartListeners = true;
        }
      }

      if (this.config.adminBot.enabled) {
        const token = this.config.adminBot.token;
        const ownerTelegramId = this.config.adminBot.ownerTelegramId;

        if (token === undefined || ownerTelegramId === undefined) {
          throw new Error('Validated Admin Bot configuration is incomplete');
        }

        this.adminBot = new AdminBotService({
          token,
          ownerTelegramId,
          logger: this.loggerHandle.logger,
          statusProvider: () => this.getStatus(),
          ...(this.accountManager === undefined
            ? {}
            : { accountController: this.accountManager }),
          ...(this.channelService === undefined
            ? {}
            : { channelController: this.channelService }),
          ...(this.ruleService === undefined
            ? {}
            : { ruleController: this.ruleService }),
          ...(this.replyTemplateService === undefined
            ? {}
            : { replyTemplateController: this.replyTemplateService }),
          ...(this.globalKeywords === undefined
            ? {}
            : { keywordController: this.globalKeywords }),
          ...(this.automationSettings === undefined
            ? {}
            : { automationSettingsController: this.automationSettings }),
          ...(this.automationSafety === undefined
            ? {}
            : { automationSafetyController: this.automationSafety }),
        });
        await this.adminBot.start();
      }

      if (shouldStartListeners && this.automationSafety?.isAutomationEnabled() === true) {
        await this.channelService?.startListeners();
      }

      this.startedAt = Date.now();
      this.state = 'running';
      this.keepAliveTimer = setInterval(() => undefined, 60_000);
      this.loggerHandle.logger.info(
        {
          action: 'application_start',
          status: 'running',
          migrationVersion: this.database.getMigrationVersion(),
          adminBotEnabled: this.config.adminBot.enabled,
        },
        'Auto WTB Bot M6 final production runtime is running',
      );
    } catch (error) {
      this.state = 'failed';
      this.loggerHandle?.logger.error(
        {
          action: 'application_start',
          status: 'failed',
          errorReason: errorReason(error),
        },
        'Auto WTB Bot startup failed',
      );
      await this.shutdown('startup failure');
      this.state = 'failed';
      throw error;
    }
  }

  public shutdown(reason = 'manual shutdown'): Promise<void> {
    if (this.shutdownPromise !== undefined) {
      return this.shutdownPromise;
    }

    this.shutdownPromise = this.shutdownInternal(reason);
    return this.shutdownPromise;
  }

  public waitForShutdown(): Promise<void> {
    return this.stoppedPromise;
  }

  public getStatus(): ApplicationStatus {
    const telegramSummary = this.telegramClients?.getSummary() ?? {
      registered: 0,
      connected: 0,
    };

    return {
      service: 'auto-wtb-bot',
      milestone: 'M6',
      state: this.state,
      uptimeSeconds:
        this.startedAt === undefined ? 0 : Math.floor((Date.now() - this.startedAt) / 1_000),
      migrationVersion: this.database?.getMigrationVersion() ?? 0,
      adminBotEnabled: this.config.adminBot.enabled,
      adminBotRunning: this.adminBot?.isRunning() ?? false,
      registeredTelegramClients: telegramSummary.registered,
      connectedTelegramClients: telegramSummary.connected,
    };
  }

  public async handleFatal(error: unknown, origin: string): Promise<void> {
    this.loggerHandle?.logger.error(
      {
        action: origin,
        status: 'fatal',
        errorReason: errorReason(error),
        err: error,
      },
      'Fatal runtime error',
    );
    await this.shutdown(origin);
  }

  private async shutdownInternal(reason: string): Promise<void> {
    if (this.state === 'stopped') {
      return;
    }

    this.state = 'stopping';
    this.loggerHandle?.logger.info(
      { action: 'application_shutdown', status: 'stopping', reason },
      'Auto WTB Bot shutdown started',
    );

    try {
      const managedShutdown = runShutdownSteps([
        ['admin_bot', async () => this.adminBot?.stop(reason)],
        ['channel_listener_stop', async () => this.channelService?.stopListeners()],
        ['auto_reply_drain', async () => this.autoReply?.shutdown()],
        ['channel_listener_drain', async () => this.channelService?.shutdown()],
        [
          'telegram_clients',
          async () => {
            if (this.accountManager !== undefined) {
              await this.accountManager.shutdown();
            } else {
              await this.telegramClients?.disconnectAll();
            }
          },
        ],
      ]);
      try {
        await withTimeout(managedShutdown, this.config.shutdownTimeoutMs);
      } catch (error) {
        this.loggerHandle?.logger.error(
          {
            action: 'application_shutdown',
            status: 'timeout_or_failure',
            errorReason: errorReason(error),
          },
          'Async shutdown exceeded its target; waiting for managed tasks before closing resources',
        );
        await managedShutdown;
      }
    } catch (error) {
      this.loggerHandle?.logger.error(
        {
          action: 'application_shutdown',
          status: 'timeout_or_failure',
          errorReason: errorReason(error),
        },
        'Async shutdown did not complete cleanly',
      );
    } finally {
      if (this.keepAliveTimer !== undefined) {
        clearInterval(this.keepAliveTimer);
        this.keepAliveTimer = undefined;
      }
      this.database?.close();
      this.state = 'stopped';
      this.loggerHandle?.logger.info(
        { action: 'application_shutdown', status: 'stopped', reason },
        'Auto WTB Bot stopped',
      );
      this.loggerHandle?.close();
      this.resolveStopped();
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Shutdown exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function runShutdownSteps(
  steps: ReadonlyArray<readonly [name: string, operation: () => Promise<unknown>]>,
): Promise<void> {
  const errors: unknown[] = [];
  for (const [name, operation] of steps) {
    try {
      await operation();
    } catch (error) {
      errors.push(new Error(`Shutdown step failed: ${name}`, { cause: error }));
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'One or more managed shutdown steps failed');
  }
}
