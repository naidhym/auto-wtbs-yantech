import { foundationMigration } from './0001-foundation.js';
import { accountSessionMigration } from './0002-account-session.js';
import { independentChannelsMigration } from './0003-independent-channels.js';
import { rulesAndTemplatesMigration } from './0004-rules-and-templates.js';
import { accountReplyTemplatesMigration } from './0005-account-reply-templates.js';
import { autoReplySafetyMigration } from './0006-auto-reply-safety.js';
import { perAccountDispatchDeduplicationMigration } from './0007-per-account-dispatch-deduplication.js';
import { accountNotificationTargetMigration } from './0008-account-notification-target.js';
import type { Migration } from './types.js';

export const migrations: readonly Migration[] = [
  foundationMigration,
  accountSessionMigration,
  independentChannelsMigration,
  rulesAndTemplatesMigration,
  accountReplyTemplatesMigration,
  autoReplySafetyMigration,
  perAccountDispatchDeduplicationMigration,
  accountNotificationTargetMigration,
];
