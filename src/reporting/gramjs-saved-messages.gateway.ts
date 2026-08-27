import { AccountService } from '../accounts/account.service.js';
import { TelegramClientRegistry } from '../user-client/telegram-client.registry.js';
import type { SavedMessagesGateway, SavedMessagesPayload } from './action-report.js';

export class GramJsSavedMessagesGateway implements SavedMessagesGateway {
  public constructor(
    private readonly accounts: AccountService,
    private readonly clients: TelegramClientRegistry,
  ) {}

  public async sendToSavedMessages(
    accountKey: string,
    payload: SavedMessagesPayload,
  ): Promise<void> {
    const account = this.accounts.get(accountKey);
    if (!account.enabled) throw new Error(`Account ${account.nickname} is disabled`);
    const client = this.clients.get(accountKey);
    if (client === undefined || !client.getStatus().connected) {
      throw new Error(`Account ${account.nickname} is not connected`);
    }
    await client.sendOperationalNotification('me', {
      text: payload.text,
      ...(payload.sourceMessageLink === undefined
        ? {}
        : {
            link: {
              label: '🔗 Open Source Message',
              url: payload.sourceMessageLink,
            },
          }),
    });
  }
}
