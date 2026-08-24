import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import pino from 'pino';

import { loadConfig } from '../src/config/config.js';
import { errorReason } from '../src/logging/logger.js';
import { GramJsClientService } from '../src/user-client/gramjs-client.service.js';

type SqlRow = Record<string, unknown>;

interface AccountInfo {
  readonly row: SqlRow;
  readonly id: number | undefined;
  readonly key: string | undefined;
  readonly label: string;
  readonly enabled: boolean;
  readonly status: string;
  readonly telegramUserId: string | undefined;
}

interface ChannelInfo {
  readonly row: SqlRow;
  readonly id: number | undefined;
  readonly telegramChannelId: string | undefined;
  readonly username: string | undefined;
  readonly title: string;
  readonly enabled: boolean;
  readonly status: string;
  readonly automationBlocked: boolean;
  readonly blockedReason: string | undefined;
}

interface AssignmentInfo {
  readonly row: SqlRow;
  readonly id: number | undefined;
  readonly accountId: number | undefined;
  readonly channelId: number | undefined;
  readonly enabled: boolean;
  readonly status: string;
  readonly account: AccountInfo | undefined;
  readonly channel: ChannelInfo | undefined;
}

interface EntityProbe {
  readonly accountKey: string | undefined;
  readonly assignmentId: number | undefined;
  readonly state: 'MATCH' | 'MISMATCH' | 'ERROR' | 'NOT_ATTEMPTED';
  readonly entityType?: string;
  readonly resolvedTelegramChannelId?: string;
  readonly error?: string;
  readonly runtimeConnected: boolean;
}

interface EventCounts {
  rawUpdates: number;
  guardAccepted: number;
  guardRejected: number;
  mapperSuccess: number;
  mapperFailed: number;
  detection: number;
  dispatch: number;
  errors: number;
  listenerStarted: number;
  listenerRegistrations: number;
  listenerRegistrationFailed: number;
}

interface AssignmentDiagnostic {
  readonly assignment: AssignmentInfo;
  readonly entity: EntityProbe;
  readonly counts: EventCounts;
  readonly listenerState: string;
  readonly firstFailingBoundary: string;
}

const diagnosticActions = new Set([
  'diagnostic_channel_assignment_loaded',
  'diagnostic_telegram_entity_resolution',
  'diagnostic_listener_registration',
  'diagnostic_raw_telegram_update',
  'diagnostic_scoped_channel_guard',
  'diagnostic_mapper',
  'diagnostic_global_detection',
  'diagnostic_dispatch',
  'channel_listener_start',
  'channel_listener_error',
  'channel_listener_start_summary',
  'telegram_client_connect',
  'session_restored',
  'channel_message_processing_error',
]);

async function main(): Promise<void> {
  const cwd = process.cwd();
  const config = loadConfig({ cwd });
  const databasePath = path.resolve(cwd, './data/auto-wtb.sqlite');
  if (!fs.existsSync(databasePath)) {
    throw new Error(`Production database was not found: ${databasePath}`);
  }

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const schema = readSchema(database);
    printSchema(schema, databasePath);

    const accounts = readAccounts(database, schema);
    const channels = readChannels(database, schema);
    const assignments = readAssignments(database, schema, accounts, channels);
    const logPaths = findLogPaths(cwd, config.storage.logDirectory);
    const logEvents = readLogEvents(logPaths);
    const databaseEvents = readDatabaseEvents(database, schema);
    printAccounts(accounts, logEvents);
    printChannels(channels);
    printAssignments(accounts, assignments);

    const activeAssignments = assignments.filter(isEffectiveAssignment);
    const probes = await probeEntities(activeAssignments, config);
    const diagnostics = activeAssignments.map((assignment) => {
      const entity = probes.get(assignmentKey(assignment)) ?? notAttemptedProbe(assignment);
      const counts = countEvents(assignment, logEvents, databaseEvents);
      const listenerState = determineListenerState(counts);
      return {
        assignment,
        entity,
        counts,
        listenerState,
        firstFailingBoundary: determineFirstFailingBoundary(entity, counts, listenerState),
      } satisfies AssignmentDiagnostic;
    });

    printProbeDetails(diagnostics);
    printLogSources(logPaths, logEvents.length, databaseEvents.length);
    printSummary(diagnostics);
    printBoundarySummary(diagnostics);
  } finally {
    database.close();
  }
}

function readSchema(database: DatabaseSync): Map<string, readonly string[]> {
  const tables = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as SqlRow[];
  const schema = new Map<string, readonly string[]>();
  for (const table of tables) {
    const name = text(table.name);
    if (name === undefined) continue;
    const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as SqlRow[];
    schema.set(name, columns.map((column) => text(column.name)).filter(isDefined));
  }
  return schema;
}

function readAccounts(database: DatabaseSync, schema: Map<string, readonly string[]>): AccountInfo[] {
  return readTable(database, schema, 'accounts').map((row) => ({
    row,
    id: integer(row.id),
    key: text(row.session_key),
    label: text(row.label) ?? '(no label)',
    enabled: enabled(row.is_enabled),
    status: text(row.status) ?? 'unknown',
    telegramUserId: text(row.telegram_user_id),
  }));
}

function readChannels(database: DatabaseSync, schema: Map<string, readonly string[]>): ChannelInfo[] {
  return readTable(database, schema, 'channels').map((row) => ({
    row,
    id: integer(row.id),
    telegramChannelId: text(row.telegram_channel_id),
    username: text(row.username),
    title: text(row.title) ?? '(no title)',
    enabled: enabled(row.is_enabled),
    status: text(row.status) ?? 'unknown',
    automationBlocked: enabled(row.automation_blocked),
    blockedReason: text(row.blocked_reason),
  }));
}

function readAssignments(
  database: DatabaseSync,
  schema: Map<string, readonly string[]>,
  accounts: readonly AccountInfo[],
  channels: readonly ChannelInfo[],
): AssignmentInfo[] {
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  const channelsById = new Map(channels.map((channel) => [channel.id, channel]));
  return readTable(database, schema, 'account_channels').map((row) => {
    const accountId = integer(row.account_id);
    const channelId = integer(row.channel_id);
    return {
      row,
      id: integer(row.id),
      accountId,
      channelId,
      enabled: enabled(row.is_enabled),
      status: text(row.status) ?? 'unknown',
      account: accountsById.get(accountId),
      channel: channelsById.get(channelId),
    };
  });
}

function readTable(
  database: DatabaseSync,
  schema: Map<string, readonly string[]>,
  table: string,
): SqlRow[] {
  if (!schema.has(table)) {
    process.stdout.write(`\n[WARN] Table '${table}' does not exist; diagnostic section omitted.\n`);
    return [];
  }
  return database.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all();
}

async function probeEntities(
  assignments: readonly AssignmentInfo[],
  config: ReturnType<typeof loadConfig>,
): Promise<Map<string, EntityProbe>> {
  const probes = new Map<string, EntityProbe>();
  const silentLogger = pino({ level: 'silent' });
  const services = new Map<string, GramJsClientService>();

  try {
    for (const assignment of assignments) {
      const accountKey = assignment.account?.key;
      const channel = assignment.channel;
      const key = assignmentKey(assignment);
      if (
        accountKey === undefined ||
        channel?.telegramChannelId === undefined ||
        config.telegram.apiId === undefined ||
        config.telegram.apiHash === undefined
      ) {
        probes.set(key, {
          accountKey,
          assignmentId: assignment.id,
          state: 'NOT_ATTEMPTED',
          error: 'missing_account_key_channel_id_or_telegram_api_configuration',
          runtimeConnected: false,
        });
        continue;
      }

      let service = services.get(accountKey);
      let runtimeConnected = false;
      try {
        if (service === undefined) {
          const session = readStoredSession(config.storage.sessionDirectory, accountKey);
          if (session === undefined) {
            throw new Error('stored_telegram_session_not_found');
          }
          service = new GramJsClientService({
            accountKey,
            apiId: config.telegram.apiId,
            apiHash: config.telegram.apiHash,
            session,
            silent: true,
            connectionRetries: 1,
            reconnectRetries: 0,
          }, silentLogger);
          services.set(accountKey, service);
          await service.connect();
          runtimeConnected = service.getStatus().connected;
          if (!runtimeConnected || !(await service.isAuthorized())) {
            throw new Error('stored_telegram_session_not_authorized');
          }
        } else {
          runtimeConnected = service.getStatus().connected;
        }

        const identifier = channel.username ?? channel.telegramChannelId;
        const resolved = await service.resolveChannel(identifier);
        const matches = resolved.telegramChannelId === channel.telegramChannelId;
        probes.set(key, {
          accountKey,
          assignmentId: assignment.id,
          state: matches ? 'MATCH' : 'MISMATCH',
          entityType: 'Api.Channel (broadcast required by current listener)',
          resolvedTelegramChannelId: resolved.telegramChannelId,
          runtimeConnected,
        });
      } catch (error) {
        probes.set(key, {
          accountKey,
          assignmentId: assignment.id,
          state: 'ERROR',
          error: errorReason(error),
          runtimeConnected,
        });
      }
    }
  } finally {
    await Promise.allSettled([...services.values()].map(async (service) => service.disconnect()));
  }
  return probes;
}

function readStoredSession(sessionDirectory: string, accountKey: string): string | undefined {
  if (!/^account-[a-f0-9-]{36}$/u.test(accountKey)) {
    throw new Error('unsafe_account_session_key');
  }
  const sessionPath = path.join(sessionDirectory, accountKey, 'telegram.session');
  if (!fs.existsSync(sessionPath)) return undefined;
  const session = fs.readFileSync(sessionPath, 'utf8').trim();
  if (session.length === 0) throw new Error('stored_telegram_session_is_empty');
  return session;
}

function findLogPaths(cwd: string, configuredLogDirectory: string): string[] {
  const paths = new Set<string>();
  const pm2Paths = findPm2LogPaths();
  for (const logPath of pm2Paths) paths.add(logPath);

  const applicationLog = path.resolve(cwd, configuredLogDirectory, 'application.log');
  if (fs.existsSync(applicationLog)) paths.add(applicationLog);
  for (const directory of [path.join(os.homedir(), '.pm2', 'logs'), path.join(cwd, 'logs')]) {
    for (const logPath of listLogFiles(directory)) paths.add(logPath);
  }
  return [...paths].filter((logPath) => fs.existsSync(logPath));
}

function findPm2LogPaths(): string[] {
  try {
    const output = execFileSync('pm2', ['jlist'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const processes = JSON.parse(output) as Array<{ name?: unknown; pm2_env?: SqlRow }>;
    const process = processes.find((candidate) => candidate.name === 'auto-wtb-bot');
    if (process?.pm2_env === undefined) return [];
    return [
      text(process.pm2_env.pm_out_log_path),
      text(process.pm2_env.pm_err_log_path),
    ].filter(isDefined);
  } catch {
    return [];
  }
}

function listLogFiles(directory: string): string[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /auto-wtb-bot|application/i.test(entry.name))
      .map((entry) => path.join(directory, entry.name));
  } catch {
    return [];
  }
}

function readLogEvents(logPaths: readonly string[]): SqlRow[] {
  const events: SqlRow[] = [];
  const seen = new Set<string>();
  for (const logPath of logPaths) {
    let lines: string[];
    try {
      lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/u);
    } catch {
      continue;
    }
    for (const line of lines) {
      const parsed = parseJsonLogLine(line);
      if (parsed === undefined) continue;
      const action = text(parsed.action);
      if (action !== undefined && diagnosticActions.has(action)) {
        const fingerprint = JSON.stringify(parsed);
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        events.push(parsed);
      }
    }
  }
  return events;
}

function parseJsonLogLine(line: string): SqlRow | undefined {
  const start = line.indexOf('{');
  if (start < 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(line.slice(start));
    return isSqlRow(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readDatabaseEvents(database: DatabaseSync, schema: Map<string, readonly string[]>): SqlRow[] {
  if (!schema.has('logs')) return [];
  return readTable(database, schema, 'logs');
}

function countEvents(
  assignment: AssignmentInfo,
  logEvents: readonly SqlRow[],
  databaseEvents: readonly SqlRow[],
): EventCounts {
  const counts: EventCounts = {
    rawUpdates: 0,
    guardAccepted: 0,
    guardRejected: 0,
    mapperSuccess: 0,
    mapperFailed: 0,
    detection: 0,
    dispatch: 0,
    errors: 0,
    listenerStarted: 0,
    listenerRegistrations: 0,
    listenerRegistrationFailed: 0,
  };

  for (const event of logEvents) {
    if (!matchesAssignment(event, assignment)) continue;
    const action = text(event.action);
    const status = text(event.status);
    if (action === 'diagnostic_raw_telegram_update') counts.rawUpdates += 1;
    if (action === 'diagnostic_scoped_channel_guard') {
      if (status === 'accepted') counts.guardAccepted += 1;
      else counts.guardRejected += 1;
    }
    if (action === 'diagnostic_mapper') {
      if (status === 'success') counts.mapperSuccess += 1;
      else counts.mapperFailed += 1;
    }
    if (action === 'diagnostic_global_detection' && status === 'matched') counts.detection += 1;
    if (action === 'diagnostic_dispatch' && status === 'selected') counts.dispatch += 1;
    if (action === 'channel_listener_start' && status === 'started') counts.listenerStarted += 1;
    if (action === 'diagnostic_listener_registration' && status === 'registered') {
      counts.listenerRegistrations += 1;
    }
    if (
      (action === 'diagnostic_listener_registration' && status === 'failed') ||
      action === 'channel_listener_error' ||
      action === 'channel_message_processing_error'
    ) {
      counts.listenerRegistrationFailed += action === 'diagnostic_listener_registration' ? 1 : 0;
      counts.errors += 1;
    }
  }

  for (const event of databaseEvents) {
    if (!matchesDatabaseEvent(event, assignment)) continue;
    const eventType = text(event.event_type);
    if (eventType === 'detection_matched') counts.detection += 1;
    if (eventType === 'reply_scheduled' || eventType === 'reply_sent') counts.dispatch += 1;
    if (eventType === 'reply_failed' || eventType === 'reaction_failed') counts.errors += 1;
  }
  return counts;
}

function matchesAssignment(event: SqlRow, assignment: AssignmentInfo): boolean {
  const eventChannelId = integer(event.channelId) ?? integer(event.channel);
  const eventAccountId = integer(event.accountId);
  const eventAccountKey = text(event.account);
  if (eventChannelId !== assignment.channelId) return false;
  if (eventAccountId !== undefined && eventAccountId !== assignment.accountId) return false;
  return eventAccountKey === undefined || eventAccountKey === assignment.account?.key;
}

function matchesDatabaseEvent(event: SqlRow, assignment: AssignmentInfo): boolean {
  return integer(event.channel_id) === assignment.channelId && integer(event.account_id) === assignment.accountId;
}

function determineListenerState(counts: EventCounts): string {
  if (counts.listenerRegistrationFailed > 0) return 'REGISTRATION_FAILED_IN_LOGS';
  if (counts.errors > 0 && counts.listenerStarted === 0) return 'LISTENER_ERROR_IN_LOGS';
  if (counts.listenerRegistrations > 0) return `REGISTERED_IN_LOGS (${counts.listenerRegistrations})`;
  if (counts.listenerStarted > 0) return 'STARTED_IN_LOGS';
  return 'NO_RUNTIME_LISTENER_EVIDENCE';
}

function determineFirstFailingBoundary(
  entity: EntityProbe,
  counts: EventCounts,
  listenerState: string,
): string {
  if (entity.state === 'ERROR' || entity.state === 'MISMATCH') return 'ENTITY_RESOLUTION';
  if (listenerState === 'REGISTRATION_FAILED_IN_LOGS' || listenerState === 'LISTENER_ERROR_IN_LOGS') {
    return 'LISTENER_REGISTRATION';
  }
  if (counts.rawUpdates === 0) {
    return listenerState === 'STARTED_IN_LOGS' ? 'RAW_UPDATE (no observed update)' : 'NO_RUNTIME_EVIDENCE';
  }
  if (counts.guardAccepted === 0 && counts.guardRejected > 0) return 'SCOPED_GUARD';
  if (counts.mapperFailed > 0 && counts.mapperSuccess === 0) return 'MAPPER';
  if (counts.guardAccepted > 0 && counts.detection === 0) return 'DETECTION';
  if (counts.detection > 0 && counts.dispatch === 0) return 'DISPATCH';
  return 'NO_FAILURE_OBSERVED';
}

function printSchema(schema: Map<string, readonly string[]>, databasePath: string): void {
  section('PRODUCTION CHANNEL DIAGNOSTIC');
  line(`Database: ${databasePath}`);
  line('Mode: read-only; no migrations, writes, listener subscriptions, posts, replies, or reactions.');
  line('Schema discovered with PRAGMA table_info:');
  for (const [table, columns] of schema) line(`  ${table}: ${columns.join(', ')}`);
}

function printAccounts(accounts: readonly AccountInfo[], logEvents: readonly SqlRow[]): void {
  section('ACCOUNTS');
  for (const account of accounts) {
    line([
      `id=${value(account.id)}`,
      `label=${account.label}`,
      `telegram_user_id=${value(account.telegramUserId)}`,
      `session_key=${value(account.key)}`,
      `status=${account.status}`,
      `is_enabled=${yesNo(account.enabled)}`,
      `runtime_log=${runtimeAccountState(account, logEvents)}`,
    ].join(' | '));
  }
}

function runtimeAccountState(account: AccountInfo, logEvents: readonly SqlRow[]): string {
  if (account.key === undefined) return 'unavailable';
  const connected = logEvents.some((event) =>
    text(event.account) === account.key &&
    (text(event.action) === 'session_restored' ||
      (text(event.action) === 'telegram_client_connect' && text(event.status) === 'connected')),
  );
  return connected ? 'restored_or_connected_in_log' : 'not_observed_in_log';
}

function printChannels(channels: readonly ChannelInfo[]): void {
  section('CHANNELS');
  for (const channel of channels) {
    line([
      `id=${value(channel.id)}`,
      `telegram_channel_id=${value(channel.telegramChannelId)}`,
      `username=${value(channel.username)}`,
      `title=${channel.title}`,
      `is_enabled=${yesNo(channel.enabled)}`,
      `status=${channel.status}`,
      `automation_blocked=${yesNo(channel.automationBlocked)}`,
      `blocked_reason=${value(channel.blockedReason)}`,
    ].join(' | '));
  }
}

function printAssignments(accounts: readonly AccountInfo[], assignments: readonly AssignmentInfo[]): void {
  section('ASSIGNMENTS GROUPED BY ACCOUNT');
  for (const account of accounts) {
    line(`\nACCOUNT ${account.label} | id=${value(account.id)} | key=${value(account.key)}`);
    const matching = assignments.filter((assignment) => assignment.accountId === account.id);
    if (matching.length === 0) line('  (no assignments)');
    for (const assignment of matching) {
      line([
        '  ',
        `assignment=${value(assignment.id)}`,
        `active=${yesNo(isEffectiveAssignment(assignment))}`,
        `assignment_enabled=${yesNo(assignment.enabled)}`,
        `assignment_status=${assignment.status}`,
        `channel_id=${value(assignment.channelId)}`,
        `channel=${assignment.channel?.title ?? '(missing)'}`,
        `telegram_channel_id=${value(assignment.channel?.telegramChannelId)}`,
        `username=${value(assignment.channel?.username)}`,
      ].join(' | '));
    }
  }
}

function printProbeDetails(diagnostics: readonly AssignmentDiagnostic[]): void {
  section('GRAMJS ENTITY RESOLUTION (STORED AUTHENTICATED SESSIONS; NO NEW LOGIN)');
  for (const diagnostic of diagnostics) {
    const { assignment, entity } = diagnostic;
    line([
      `ACCOUNT=${assignment.account?.label ?? '(missing)'}`,
      `CHANNEL_DB_ID=${value(assignment.channelId)}`,
      `TITLE=${assignment.channel?.title ?? '(missing)'}`,
      `USERNAME=${value(assignment.channel?.username)}`,
      `EXPECTED_TELEGRAM_CHANNEL_ID=${value(assignment.channel?.telegramChannelId)}`,
      `RESOLVED_ENTITY_TYPE=${value(entity.entityType)}`,
      `RESOLVED_TELEGRAM_CHANNEL_ID=${value(entity.resolvedTelegramChannelId)}`,
      `MATCH=${entity.state}`,
      `CONNECTED=${yesNo(entity.runtimeConnected)}`,
      ...(entity.error === undefined ? [] : [`RESOLUTION_ERROR=${entity.error}`]),
    ].join(' | '));
  }
}

function printLogSources(logPaths: readonly string[], logEventCount: number, databaseEventCount: number): void {
  section('LOG SOURCES');
  line(`PM2/application log paths discovered: ${logPaths.length === 0 ? '(none)' : logPaths.join(', ')}`);
  line(`Relevant structured runtime log events read: ${logEventCount}`);
  line(`Database log rows read: ${databaseEventCount}`);
  line('Live listener map is process memory and cannot be read by a separate PM2 command; listener state below is derived from startup/registration logs.');
}

function printSummary(diagnostics: readonly AssignmentDiagnostic[]): void {
  section('WORKING VS BROKEN SUMMARY (ONE ROW PER ACTIVE ASSIGNMENT)');
  const headers = [
    'Channel', 'Account', 'Entity Match', 'Listener', 'Raw Updates', 'Guard Accepted',
    'Guard Rejected', 'Mapper', 'Detection', 'Dispatch', 'Errors', 'First Boundary',
  ];
  const rows = diagnostics.map((diagnostic) => [
    diagnostic.assignment.channel?.title ?? `channel-${value(diagnostic.assignment.channelId)}`,
    diagnostic.assignment.account?.label ?? `account-${value(diagnostic.assignment.accountId)}`,
    diagnostic.entity.state,
    diagnostic.listenerState,
    String(diagnostic.counts.rawUpdates),
    String(diagnostic.counts.guardAccepted),
    String(diagnostic.counts.guardRejected),
    `${diagnostic.counts.mapperSuccess}/${diagnostic.counts.mapperFailed}`,
    String(diagnostic.counts.detection),
    String(diagnostic.counts.dispatch),
    String(diagnostic.counts.errors),
    diagnostic.firstFailingBoundary,
  ]);
  printTable(headers, rows);
}

function printBoundarySummary(diagnostics: readonly AssignmentDiagnostic[]): void {
  section('FIRST FAILING BOUNDARY');
  for (const diagnostic of diagnostics) {
    line([
      `account=${diagnostic.assignment.account?.label ?? value(diagnostic.assignment.accountId)}`,
      `channel=${diagnostic.assignment.channel?.title ?? value(diagnostic.assignment.channelId)}`,
      `assignment=${value(diagnostic.assignment.id)}`,
      `boundary=${diagnostic.firstFailingBoundary}`,
    ].join(' | '));
  }
  line('A boundary is evidence classification, not a root-cause claim. RAW_UPDATE means no relevant raw update was observed in the logs inspected.');
}

function printTable(headers: readonly string[], rows: readonly (readonly string[])[]): void {
  const widths = headers.map((header, index) => Math.min(36, Math.max(
    header.length,
    ...rows.map((row) => (row[index] ?? '').length),
  )));
  const format = (row: readonly string[]) => row.map((cell, index) => truncate(cell, widths[index] ?? 36)
    .padEnd(widths[index] ?? 36)).join(' | ');
  line(format(headers));
  line(widths.map((width) => '-'.repeat(width)).join('-|-'));
  for (const row of rows) line(format(row));
}

function isEffectiveAssignment(assignment: AssignmentInfo): boolean {
  return assignment.enabled && assignment.account?.enabled === true && assignment.channel?.enabled === true &&
    assignment.channel.automationBlocked !== true;
}

function assignmentKey(assignment: AssignmentInfo): string {
  return `${value(assignment.accountId)}:${value(assignment.channelId)}:${value(assignment.id)}`;
}

function notAttemptedProbe(assignment: AssignmentInfo): EntityProbe {
  return {
    accountKey: assignment.account?.key,
    assignmentId: assignment.id,
    state: 'NOT_ATTEMPTED',
    error: 'probe_result_missing',
    runtimeConnected: false,
  };
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function enabled(value: unknown): boolean {
  return value === 1 || value === true || value === '1' || value === 'true';
}

function integer(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  if (typeof value === 'string' && /^-?\d+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function isSqlRow(value: unknown): value is SqlRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function value(input: string | number | undefined): string {
  return input === undefined ? '-' : String(input);
}

function yesNo(input: boolean): string {
  return input ? 'YES' : 'NO';
}

function truncate(input: string, width: number): string {
  return input.length <= width ? input : `${input.slice(0, Math.max(1, width - 1))}…`;
}

function section(title: string): void {
  process.stdout.write(`\n=== ${title} ===\n`);
}

function line(output: string): void {
  process.stdout.write(`${output}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`Production channel diagnostic failed: ${errorReason(error)}\n`);
  process.exitCode = 1;
});
