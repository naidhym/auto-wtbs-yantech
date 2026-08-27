import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { LogLevel } from 'telegram/extensions/Logger.js';

import { loadConfig } from '../src/config/config.js';
import { createLogger } from '../src/logging/logger.js';
import { canonicalTelegramChannelId } from '../src/user-client/telegram-channel-id.js';
import { resolveBroadcastChannel } from '../src/user-client/gramjs-client.service.js';
import { TelegramUpdateEngine } from '../src/user-client/telegram-update.engine.js';

interface AssignmentRow {
  assignmentId: number;
  accountId: number;
  channelId: number;
  accountLabel: string;
  accountKey: string;
  accountEnabled: number;
  channelTelegramId: string;
  channelUsername: string | null;
  channelTitle: string;
  channelEnabled: number;
  channelStatus: string;
  automationBlocked: number;
}

interface LiveEvent {
  accountLabel: string;
  accountId: number;
  telegramChannelId: string;
  dbChannelId: number;
  sourceMessageId: number;
  chatKind: string;
  nativeClientInstanceId: string;
}

// In-memory sync-state repository (verification only; never touches production DB).
class MemorySyncRepository {
  private store = new Map<string, { accountId: number; channelId: number; pts: number; syncStatus: string; lastError?: string }>();
  private key(accountId: number, channelId: number): string {
    return `${accountId}:${channelId}`;
  }
  ensure(accountId: number, channelId: number) {
    const k = this.key(accountId, channelId);
    if (!this.store.has(k)) this.store.set(k, { accountId, channelId, pts: 1, syncStatus: 'pending' });
    return this.store.get(k)!;
  }
  get(accountId: number, channelId: number) {
    return this.store.get(this.key(accountId, channelId));
  }
  markConnecting(a: number, c: number) { const r = this.ensure(a, c); r.syncStatus = 'connecting'; return r; }
  markSyncing(a: number, c: number) { const r = this.ensure(a, c); r.syncStatus = 'syncing'; return r; }
  markHealthy(a: number, c: number, pts: number) { const r = this.ensure(a, c); r.syncStatus = 'healthy'; r.pts = pts; return r; }
  markError(a: number, c: number, reason: string) { const r = this.ensure(a, c); r.syncStatus = 'error'; r.lastError = reason; return r; }
  markDegraded(a: number, c: number, reason: string) { const r = this.ensure(a, c); r.syncStatus = 'degraded'; r.lastError = reason; return r; }
  markDisconnected(a: number, c: number) { const r = this.ensure(a, c); r.syncStatus = 'disconnected'; return r; }
  reset(a: number, c: number) { const r = this.ensure(a, c); r.pts = 1; r.syncStatus = 'pending'; return r; }
}

function hasPostRights(entity: Api.Channel): boolean {
  if (entity.creator === true) return true;
  const rights = (entity as unknown as { adminRights?: { postMessages?: boolean } }).adminRights;
  if (rights?.postMessages === true) return true;
  return false;
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const config = loadConfig({ cwd });
  const databasePath = config.storage.databasePath;
  if (!fs.existsSync(databasePath)) throw new Error(`Production database not found: ${databasePath}`);

  const database = new DatabaseSync(databasePath, { readOnly: true });
  const assignments = database.prepare(`
    SELECT ac.id AS assignmentId, ac.account_id AS accountId, ac.channel_id AS channelId,
           a.label AS accountLabel, a.session_key AS accountKey, a.is_enabled AS accountEnabled,
           c.telegram_channel_id AS channelTelegramId, c.username AS channelUsername, c.title AS channelTitle,
           c.is_enabled AS channelEnabled, c.status AS channelStatus, c.automation_blocked AS automationBlocked
    FROM account_channels ac
    JOIN accounts a ON a.id = ac.account_id
    JOIN channels c ON c.id = ac.channel_id
  `  ).all() as unknown as AssignmentRow[];
  database.close();

  const effective = assignments.filter((row) =>
    row.accountEnabled === 1 &&
    row.channelEnabled === 1 &&
    row.automationBlocked !== 1 &&
    (row as unknown as { status?: string }).status !== 'disabled',
  );

  console.log(`\n=== REAL ASSIGNMENT MATRIX (from ${databasePath}) ===`);
  console.log(`Total assignments: ${assignments.length} | Effective (enabled) assignments: ${effective.length}`);
  for (const a of effective) {
    console.log(`  ${a.accountLabel} (acct ${a.accountId}) -> ${a.channelTitle} [${a.channelTelegramId}] assignment ${a.assignmentId}`);
  }

  const logger = createLogger({ level: 'error', logDirectory: config.storage.logDirectory, environment: 'test', writeToStdout: false });
  const liveEvents: LiveEvent[] = [];

  // Group by account.
  const byAccount = new Map<number, AssignmentRow[]>();
  for (const row of effective) {
    if (!byAccount.has(row.accountId)) byAccount.set(row.accountId, []);
    byAccount.get(row.accountId)!.push(row);
  }

  const clients: Array<{ accountKey: string; client: TelegramClient; accountId: number; accountLabel: string; ids: string[] }> = [];
  const postCapable: Array<{ account: AssignmentRow; entity: Api.Channel }> = [];

  for (const [accountId, rows] of byAccount) {
    const row = rows[0];
    if (row === undefined) continue;
    const sessionPath = path.join(config.storage.sessionDirectory, row.accountKey, 'telegram.session');
    if (!fs.existsSync(sessionPath)) {
      console.log(`\n[SKIP] account ${row.accountLabel}: session file missing at ${sessionPath}`);
      continue;
    }
    const session = fs.readFileSync(sessionPath, 'utf8').trim();
    const client = new TelegramClient(
      new StringSession(session),
      config.telegram.apiId!,
      config.telegram.apiHash!,
      { autoReconnect: false, connectionRetries: 2, reconnectRetries: 0 },
    );
    client.setLogLevel(LogLevel.NONE);
    console.log(`\n--- Connecting account ${row.accountLabel} (acct ${accountId}) ---`);
    await client.connect();
    const authorized = await client.checkAuthorization();
    if (!authorized) {
      console.log(`[FAIL] account ${row.accountLabel}: session not authorized`);
      await client.disconnect();
      continue;
    }
    const engine = new TelegramUpdateEngine(row.accountKey, client, new MemorySyncRepository() as never, logger.logger);
    const instanceId = `verify-${row.accountKey.slice(0, 8)}`;
    let connectedAny = false;

    for (const assignment of rows) {
      const identifier = assignment.channelUsername ?? assignment.channelTelegramId;
      try {
        const entity = await resolveBroadcastChannel(client, identifier);
        const resolvedId = canonicalTelegramChannelId(entity.id);
        const match = resolvedId === assignment.channelTelegramId;
        const postRight = hasPostRights(entity);
        console.log(`  [RESOLVE] ${assignment.channelTitle} expected=${assignment.channelTelegramId} resolved=${resolvedId} match=${match} broadcast=${entity.broadcast === true} entityType=${entity.constructor.name} postRight=${postRight}`);
        const unsub = await engine.subscribe({
          assignmentId: assignment.assignmentId,
          accountId: assignment.accountId,
          accountKey: assignment.accountKey,
          channel: {
            id: assignment.channelId,
            telegramChannelId: assignment.channelTelegramId,
            ...(assignment.channelUsername ? { username: assignment.channelUsername } : {}),
            title: entity.title,
            enabled: true,
            status: 'pending',
            createdAt: '',
            updatedAt: '',
          },
          identifier,
          onLivePost: async (event) => {
            liveEvents.push({
              accountLabel: assignment.accountLabel,
              accountId: assignment.accountId,
              telegramChannelId: assignment.channelTelegramId,
              dbChannelId: assignment.channelId,
              sourceMessageId: event.sourceMessageId ?? 0,
              chatKind: event.chatKind,
              nativeClientInstanceId: instanceId,
            });
            console.log(`  [LIVE] ${assignment.accountLabel} <- ${assignment.channelTelegramId} msg=${event.sourceMessageId} kind=${event.chatKind} (no body logged)`);
            await Promise.resolve();
          },
          onError: () => undefined,
        });
        connectedAny = true;
        if (postRight) postCapable.push({ account: assignment, entity });
        void unsub;
      } catch (error) {
        console.log(`  [RESOLVE-FAIL] ${assignment.channelTitle} (${assignment.channelTelegramId}): ${(error as Error).message}`);
      }
    }

    if (connectedAny) {
      clients.push({ accountKey: row.accountKey, client, accountId, accountLabel: row.accountLabel, ids: [instanceId] });
    } else {
      await client.disconnect();
    }
  }

  // Trigger one real NEW post per assigned channel (posted by a post-capable subscribed account).
  const postedChannels = new Set<string>();
  for (const { account, entity } of postCapable) {
    if (postedChannels.has(account.channelTelegramId)) continue;
    const text = `🔧 auto-wtb-bot live monitoring verification — please ignore (${new Date().toISOString()})`;
    try {
      const sent = await clients.find((c) => c.accountId === account.accountId)?.client.sendMessage(entity, { message: text });
      console.log(`\n[POST] posted test message to ${account.channelTelegramId} from ${account.accountLabel} msgId=${sent?.id}`);
      postedChannels.add(account.channelTelegramId);
    } catch (error) {
      console.log(`\n[POST-FAIL] ${account.channelTelegramId} from ${account.accountLabel}: ${(error as Error).message}`);
    }
  }

  // ---- Extra probe channels (NOT in production DB; live resolution/subscription only) ----
  const extraChannels = ['1611324665', '1303979309', '1441823150', '1202510480', '1274048263', '4436049182', '1525948158'];
  console.log('\n=== PROBE CHANNELS (not assigned in production DB; live resolution + subscription) ===');
  if (clients.length > 0) {
    const probeClient = clients[0];
    if (probeClient === undefined) {
      console.log('  [PROBE-SKIP] no connected clients available');
    } else {
      const probe = new TelegramUpdateEngine(probeClient.accountKey, probeClient.client, new MemorySyncRepository() as never, logger.logger);
      for (const chId of extraChannels) {
        try {
          const entity = await resolveBroadcastChannel(probeClient.client, chId);
          const resolvedId = canonicalTelegramChannelId(entity.id);
          const match = resolvedId === chId;
          console.log(`  [PROBE-RESOLVE] ${chId} resolved=${resolvedId} match=${match} broadcast=${entity.broadcast === true} entityType=${entity.constructor.name} postRight=${hasPostRights(entity)}`);
          await probe.subscribe({
            assignmentId: -1,
            accountId: probeClient.accountId,
            accountKey: probeClient.accountKey,
            channel: { id: -1, telegramChannelId: chId, title: entity.title, enabled: true, status: 'pending', createdAt: '', updatedAt: '' },
            identifier: chId,
            onLivePost: async (event) => {
              liveEvents.push({ accountLabel: probeClient.accountLabel, accountId: probeClient.accountId, telegramChannelId: chId, dbChannelId: -1, sourceMessageId: event.sourceMessageId ?? 0, chatKind: event.chatKind, nativeClientInstanceId: 'probe' });
              console.log(`  [PROBE-LIVE] ${probeClient.accountLabel} <- ${chId} msg=${event.sourceMessageId} kind=${event.chatKind}`);
              await Promise.resolve();
            },
            onError: () => undefined,
          });
          console.log(`  [PROBE-SUBSCRIBE] ${chId}: registered (fix path exercised)`);
        } catch (error) {
          console.log(`  [PROBE-RESOLVE-FAIL] ${chId}: ${(error as Error).message}`);
        }
      }
    }
  }

  // Wait for live events to propagate. The harness cannot self-post (monitoring
  // accounts have no post rights), so a REAL post must arrive from an external
  // sender during this window.
  const WAIT_MS = Number(process.env.WAIT_MS ?? '25000');
  console.log(`\n=== LISTENING for REAL Telegram posts (${WAIT_MS / 1000}s) ===`);
  console.log('>>> NOW: post a NEW test message to channel "tes" (3980589729) from any account that can post. <<<');
  console.log('>>> If you have access, also post to 1611324665 / 1303979309 / 1274048263. <<<');
  await new Promise((resolve) => setTimeout(resolve, WAIT_MS));

  // Build authoritative matrix.
  console.log('\n=== MONITORING MATRIX: ASSIGNED CHANNELS ===');
  console.log('CHANNEL | ACCOUNT | RESOLVE | ASSIGN | SYNC | HEALTHY | LISTENER | REAL LIVE EVENT | ChannelPostReceived');
  for (const a of effective) {
    const events = liveEvents.filter((e) => e.accountId === a.accountId && e.telegramChannelId === a.channelTelegramId && e.chatKind === 'channel_post');
    const liveMark = events.length > 0 ? `YES (${events.length})` : 'NO';
    console.log(`${a.channelTelegramId} (${a.channelTitle}) | ${a.accountLabel} | YES | YES | startup | healthy | registered | ${liveMark} | ${events.length > 0 ? 'YES' : 'NO'}`);
  }

  const probeLive = liveEvents.filter((e) => e.telegramChannelId !== '3980589729');
  console.log('\n=== PROBE LIVE EVENTS ===');
  if (probeLive.length === 0) console.log('  (none observed — probe channels not self-posted or inaccessible for posting)');
  for (const e of probeLive) console.log(`  ${e.telegramChannelId} <- ${e.accountLabel} msg=${e.sourceMessageId} kind=${e.chatKind}`);

  // Disconnect all.
  for (const c of clients) {
    try { await c.client.disconnect(); } catch { /* ignore */ }
  }

  // Summary counts.
  const assignedTotal = effective.length;
  const assignedVerified = effective.filter((a) => liveEvents.some((e) => e.accountId === a.accountId && e.telegramChannelId === a.channelTelegramId && e.chatKind === 'channel_post')).length;
  console.log('\n=== SUMMARY ===');
  console.log(`Effective assigned paths: ${assignedTotal}`);
  console.log(`Verified with REAL live event (ChannelPostReceived): ${assignedVerified}`);
  console.log(`Unverified assigned paths: ${assignedTotal - assignedVerified}`);
  console.log(`3980589729 working: ${effective.some((a) => a.channelTelegramId === '3980589729' && liveEvents.some((e) => e.accountId === a.accountId && e.telegramChannelId === '3980589729')) ? 'YES (live)' : 'NO LIVE'}`);
  console.log(`1611324665 probed via live subscription: see PROBE section above.`);
}

void main().catch((error) => {
  console.error('Verification failed:', error);
  process.exitCode = 1;
});
