export type AccountConnectionStatus =
  | 'disabled'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

export interface AccountRecord {
  readonly id: number;
  readonly ownerId: number;
  readonly accountKey: string;
  readonly nickname: string;
  /** Backward-compatible alias for the persisted nickname column. */
  readonly label: string;
  readonly phoneNumber: string;
  readonly telegramUserId?: string;
  readonly status: AccountConnectionStatus;
  readonly enabled: boolean;
  readonly lastConnectedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateAccountInput {
  readonly label: string;
  readonly phoneNumber: string;
}
