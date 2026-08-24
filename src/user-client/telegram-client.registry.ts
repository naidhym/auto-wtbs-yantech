import type { AppLogger } from '../logging/logger.js';
import {
  GramJsClientService,
  type GramJsClientOptions,
  type TelegramClientFactory,
} from './gramjs-client.service.js';

export interface TelegramClientRegistrySummary {
  readonly registered: number;
  readonly connected: number;
}

export class TelegramClientRegistry {
  private readonly clients = new Map<string, GramJsClientService>();

  public constructor(private readonly logger: AppLogger) {}

  public register(
    options: GramJsClientOptions,
    clientFactory?: TelegramClientFactory,
  ): GramJsClientService {
    if (this.clients.has(options.accountKey)) {
      throw new Error(`Telegram client already registered for account ${options.accountKey}`);
    }

    const service = new GramJsClientService(options, this.logger, clientFactory);
    this.clients.set(options.accountKey, service);
    return service;
  }

  public get(accountKey: string): GramJsClientService | undefined {
    return this.clients.get(accountKey);
  }

  public has(accountKey: string): boolean {
    return this.clients.has(accountKey);
  }

  public async unregister(accountKey: string, destroy = true): Promise<void> {
    const client = this.clients.get(accountKey);

    if (client === undefined) {
      return;
    }

    if (destroy) {
      await client.destroy();
    }

    this.clients.delete(accountKey);
  }

  public getSummary(): TelegramClientRegistrySummary {
    const statuses = [...this.clients.values()].map((client) => client.getStatus());

    return {
      registered: statuses.length,
      connected: statuses.filter((status) => status.connected).length,
    };
  }

  public async disconnectAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.clients.values()].map(async (client) => client.destroy()),
    );
    const failures = results.filter((result) => result.status === 'rejected');

    if (failures.length > 0) {
      this.logger.error(
        {
          action: 'telegram_clients_disconnect_all',
          status: 'partial_failure',
          failedCount: failures.length,
        },
        'One or more Telegram clients failed to disconnect',
      );
    }

    this.clients.clear();
  }
}
