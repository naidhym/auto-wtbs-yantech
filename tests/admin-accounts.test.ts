import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Telegraf, Telegram } from 'telegraf';
import { describe, expect, it, vi, type MockInstance } from 'vitest';

import type { LoginStatus } from '../src/accounts/account-manager.service.js';
import type { AccountRecord } from '../src/accounts/account.types.js';
import type { AccountAutomationSettings } from '../src/automation/automation.types.js';
import {
  AdminBotService,
  type AdminAccountController,
  type AdminAccountAutomationController,
  type AdminAutomationSafetyController,
  type AdminChannelController,
  type AdminGlobalKeywordController,
  type AdminReplyTemplateController,
  type AdminRuleController,
  type AdminBotLifecycleAdapter,
} from '../src/admin-bot/admin-bot.service.js';
import type { ChannelAssignmentRecord, ChannelRecord } from '../src/channels/channel.types.js';
import type { ReplyTemplateRecord, RuleInput, RuleRecord } from '../src/rules/rule.types.js';
import { createLogger, type LoggerHandle } from '../src/logging/logger.js';

const OWNER_ID = 123456789;
const FIRST_KEY = 'account-00000000-0000-4000-8000-000000000501';
const ADDED_KEY = 'account-00000000-0000-4000-8000-000000000502';

class FakeAccountController implements AdminAccountController {
  public accounts: AccountRecord[] = [testAccount(FIRST_KEY, 'Primary')];
  public listCalls = 0;
  public reconnectCalls: string[] = [];
  public disconnectCalls: string[] = [];
  public enableCalls: string[] = [];
  public disableCalls: string[] = [];
  public removeCalls: string[] = [];
  public renameCalls: Array<{ accountKey: string; nickname: string }> = [];
  public addedPhone?: string;
  public addedNickname?: string;
  public submittedOtp?: string;
  public submittedPassword?: string;

  public listAccounts(): AccountRecord[] {
    this.listCalls += 1;
    return [...this.accounts];
  }

  public getAccount(accountKey: string): AccountRecord {
    const account = this.accounts.find((item) => item.accountKey === accountKey);
    if (account === undefined) throw new Error(`Account not found: ${accountKey}`);
    return account;
  }

  public addAccount(input: { phoneNumber: string; label: string }): AccountRecord {
    this.addedPhone = input.phoneNumber;
    this.addedNickname = input.label;
    const account = testAccount(ADDED_KEY, input.label, input.phoneNumber, false);
    this.accounts.push(account);
    return account;
  }

  public validateNickname(nickname: string, excludeAccountKey?: string): string {
    const normalized = nickname.trim().replace(/\s+/g, ' ');
    if (normalized.length < 1 || normalized.length > 64) {
      throw new Error('Account nickname must contain 1-64 characters');
    }
    if (
      this.accounts.some(
        (account) =>
          account.accountKey !== excludeAccountKey &&
          account.nickname.toLowerCase() === normalized.toLowerCase(),
      )
    ) {
      throw new Error('An account with this nickname already exists');
    }
    return normalized;
  }

  public rename(accountKey: string, nickname: string): AccountRecord {
    this.renameCalls.push({ accountKey, nickname });
    this.accounts = this.accounts.map((account) =>
      account.accountKey === accountKey
        ? { ...account, nickname, label: nickname }
        : account,
    );
    return this.getAccount(accountKey);
  }

  public startLogin(accountKey: string): Promise<LoginStatus> {
    return Promise.resolve({ accountKey, state: 'awaiting_otp' });
  }

  public submitOtp(accountKey: string, otp: string): Promise<LoginStatus> {
    this.submittedOtp = otp;
    return Promise.resolve({ accountKey, state: 'awaiting_password' });
  }

  public submitPassword(
    accountKey: string,
    password: string,
  ): Promise<LoginStatus> {
    this.submittedPassword = password;
    this.accounts = this.accounts.map((account) =>
      account.accountKey === accountKey
        ? { ...account, enabled: true, status: 'connected' }
        : account,
    );
    return Promise.resolve({ accountKey, state: 'authenticated' });
  }

  public cancelLogin(accountKey: string): Promise<LoginStatus> {
    return Promise.resolve({ accountKey, state: 'cancelled' });
  }

  public reconnect(accountKey: string): Promise<void> {
    this.reconnectCalls.push(accountKey);
    return Promise.resolve();
  }

  public disconnect(accountKey: string): Promise<void> {
    this.disconnectCalls.push(accountKey);
    return Promise.resolve();
  }

  public enable(accountKey: string): Promise<AccountRecord> {
    this.enableCalls.push(accountKey);
    return Promise.resolve(this.getAccount(accountKey));
  }

  public disable(accountKey: string): Promise<AccountRecord> {
    this.disableCalls.push(accountKey);
    return Promise.resolve(this.getAccount(accountKey));
  }

  public remove(accountKey: string): Promise<void> {
    this.removeCalls.push(accountKey);
    this.accounts = this.accounts.filter((account) => account.accountKey !== accountKey);
    return Promise.resolve();
  }

  public getLoginStatus(_accountKey: string): LoginStatus | undefined {
    void _accountKey;
    return undefined;
  }
}

class FakeChannelController implements AdminChannelController {
  public channels: ChannelRecord[] = [];
  public assignments: ChannelAssignmentRecord[] = [];
  public added?: { identifier: string; accountKey: string };
  public removed: number[] = [];

  public constructor(private readonly accounts: FakeAccountController) {}
  public listChannels(): ChannelRecord[] { return [...this.channels]; }
  public listAccounts(): AccountRecord[] { return this.accounts.listAccounts(); }
  public getChannel(channelId: number) {
    const channel = this.channels.find((item) => item.id === channelId);
    if (channel === undefined) throw new Error('Channel not found');
    return { channel, assignments: this.assignments.filter((item) => item.channelId === channelId) };
  }
  public listAccountChannels(accountKey: string) {
    return this.assignments.filter((item) => item.accountKey === accountKey).map((assignment) => ({
      assignment,
      channel: this.getChannel(assignment.channelId).channel,
    }));
  }
  public addChannel(identifier: string, accountKey: string) {
    this.added = { identifier, accountKey };
    const channel = testChannel();
    this.channels = [channel];
    const account = this.accounts.getAccount(accountKey);
    this.assignments = [testAssignment(1, account, channel.id)];
    return Promise.resolve({ channel });
  }
  public assignAccount(channelId: number, accountKey: string): Promise<void> {
    const account = this.accounts.getAccount(accountKey);
    this.assignments.push(testAssignment(this.assignments.length + 1, account, channelId));
    return Promise.resolve();
  }
  public unassign(assignmentId: number): Promise<void> {
    this.assignments = this.assignments.filter((item) => item.id !== assignmentId);
    return Promise.resolve();
  }
  public setChannelEnabled(channelId: number, enabled: boolean): Promise<void> {
    this.channels = this.channels.map((item) => item.id === channelId ? { ...item, enabled } : item);
    return Promise.resolve();
  }
  public setAssignmentEnabled(assignmentId: number, enabled: boolean): Promise<void> {
    this.assignments = this.assignments.map((item) => item.id === assignmentId ? { ...item, enabled } : item);
    return Promise.resolve();
  }
  public removeChannel(channelId: number): Promise<void> {
    this.removed.push(channelId);
    this.channels = this.channels.filter((item) => item.id !== channelId);
    this.assignments = this.assignments.filter((item) => item.channelId !== channelId);
    return Promise.resolve();
  }
  public stopAccountListeners(): Promise<void> { return Promise.resolve(); }
  public restartAccountListeners(): Promise<void> { return Promise.resolve(); }
}

class FakeTemplateController implements AdminReplyTemplateController {
  public templates: ReplyTemplateRecord[] = [];
  public list(accountKey: string): ReplyTemplateRecord[] {
    return this.templates.filter((item) => item.accountKey === accountKey);
  }
  public get(accountKey: string, templateId: number): ReplyTemplateRecord {
    const template = this.templates.find(
      (item) => item.id === templateId && item.accountKey === accountKey,
    );
    if (template === undefined) throw new Error('Template not found');
    return template;
  }
  public create(accountKey: string, name: string, body: string): ReplyTemplateRecord {
    const template = testTemplate(this.templates.length + 1, accountKey, name, body);
    this.templates.push(template);
    return template;
  }
  public update(
    accountKey: string,
    templateId: number,
    name: string,
    body: string,
  ): ReplyTemplateRecord {
    this.templates = this.templates.map((item) =>
      item.id === templateId && item.accountKey === accountKey
        ? { ...item, name, body }
        : item);
    return this.get(accountKey, templateId);
  }
  public setEnabled(
    accountKey: string,
    templateId: number,
    enabled: boolean,
  ): ReplyTemplateRecord {
    this.templates = this.templates.map((item) =>
      item.id === templateId && item.accountKey === accountKey
        ? { ...item, enabled }
        : item);
    return this.get(accountKey, templateId);
  }
  public remove(accountKey: string, templateId: number): void {
    this.templates = this.templates.filter(
      (item) => item.id !== templateId || item.accountKey !== accountKey,
    );
  }
}

class FakeRuleController implements AdminRuleController {
  public rules: RuleRecord[] = [];
  public list(): RuleRecord[] { return [...this.rules]; }
  public get(ruleId: number): RuleRecord {
    const rule = this.rules.find((item) => item.id === ruleId);
    if (rule === undefined) throw new Error('Rule not found');
    return rule;
  }
  public create(input: RuleInput): RuleRecord {
    const rule = testRule(1, input);
    this.rules.push(rule);
    return rule;
  }
  public update(ruleId: number, input: RuleInput): RuleRecord {
    this.rules = this.rules.map((item) => item.id === ruleId ? { ...testRule(ruleId, input), enabled: item.enabled } : item);
    return this.get(ruleId);
  }
  public setEnabled(ruleId: number, enabled: boolean): RuleRecord {
    this.rules = this.rules.map((item) => item.id === ruleId ? { ...item, enabled } : item);
    return this.get(ruleId);
  }
  public remove(ruleId: number): void {
    this.rules = this.rules.filter((item) => item.id !== ruleId);
  }
}

class FakeGlobalKeywordController implements AdminGlobalKeywordController {
  public triggerKeywords: string[] = [];
  public excludeKeywords: string[] = [];
  public cleanupPatterns: string[] = [];
  public enabled = true;

  public getConfiguration() {
    return {
      triggerKeywords: [...this.triggerKeywords],
      excludeKeywords: [...this.excludeKeywords],
      cleanupPatterns: [...this.cleanupPatterns],
      enabled: this.enabled,
    };
  }
  public setTriggerKeywords(value: string): readonly string[] {
    this.triggerKeywords = parseKeywords(value);
    return this.triggerKeywords;
  }
  public setExcludeKeywords(value: string): readonly string[] {
    this.excludeKeywords = parseKeywords(value);
    return this.excludeKeywords;
  }
  public setCleanupPatterns(value: string): readonly string[] {
    this.cleanupPatterns = parseKeywords(value);
    return this.cleanupPatterns;
  }
  public setEnabled(enabled: boolean): void { this.enabled = enabled; }
}

class FakeAutomationSettingsController implements AdminAccountAutomationController {
  public settings = new Map<string, AccountAutomationSettings>();

  public constructor(private readonly accounts: FakeAccountController) {}

  public get(accountKey: string): AccountAutomationSettings {
    const existing = this.settings.get(accountKey);
    if (existing !== undefined) return existing;
    const account = this.accounts.getAccount(accountKey);
    const created: AccountAutomationSettings = {
      accountId: account.id,
      accountKey,
      accountNickname: account.nickname,
      replyDelayMs: 0,
      autoReaction: false,
      cooldownMs: 0,
      hourlyLimit: 0,
      dailyLimit: 0,
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    this.settings.set(accountKey, created);
    return created;
  }

  public setReplyDelay(accountKey: string, seconds: string) {
    return this.update(accountKey, { replyDelayMs: Math.round(Number(seconds) * 1_000) });
  }
  public setAutoReaction(accountKey: string, enabled: boolean) {
    return this.update(accountKey, { autoReaction: enabled });
  }
  public setCooldown(accountKey: string, seconds: string) {
    return this.update(accountKey, { cooldownMs: Math.round(Number(seconds) * 1_000) });
  }
  public setHourlyLimit(accountKey: string, value: string) {
    return this.update(accountKey, { hourlyLimit: Number(value) });
  }
  public setDailyLimit(accountKey: string, value: string) {
    return this.update(accountKey, { dailyLimit: Number(value) });
  }
  public setNotificationTarget(accountKey: string, value: string) {
    if (value === '-') {
      return this.get(accountKey);
    }
    return this.update(accountKey, { notificationTarget: value.trim() });
  }
  private update(accountKey: string, change: Partial<AccountAutomationSettings>) {
    const updated = { ...this.get(accountKey), ...change };
    this.settings.set(accountKey, updated);
    return updated;
  }
}

class FakeAutomationSafetyController implements AdminAutomationSafetyController {
  public enabled = true;
  public stopCalls = 0;
  public resumeCalls = 0;
  public resumedChannels: number[] = [];
  public constructor(private readonly channels: FakeChannelController) {}
  public getStatus() { return { enabled: this.enabled }; }
  public stopAll(): Promise<void> {
    this.enabled = false;
    this.stopCalls += 1;
    return Promise.resolve();
  }
  public resumeAll(): Promise<void> {
    this.enabled = true;
    this.resumeCalls += 1;
    return Promise.resolve();
  }
  public resumeChannel(channelId: number): Promise<void> {
    this.resumedChannels.push(channelId);
    this.channels.channels = this.channels.channels.map((channel) => {
      if (channel.id !== channelId) return channel;
      const { blockedReason, blockedAt, ...rest } = channel;
      void blockedReason;
      void blockedAt;
      return { ...rest, automationBlocked: false };
    });
    return Promise.resolve();
  }
}

describe('Admin Bot button-first M2 UX', () => {
  it('/start opens the main menu and Accounts renders button navigation', async () => {
    const harness = await createBotHarness();

    await harness.bot.handleUpdate(commandUpdate(1, OWNER_ID, '/start'));
    const mainPayload = lastPayload(harness.callApi, 'sendMessage');
    expect(mainPayload?.text).toContain('Choose an option');
    expect(JSON.stringify(mainPayload)).toContain('👤 Accounts');
    expect(JSON.stringify(mainPayload)).toContain('m:accounts');
    expect(JSON.stringify(mainPayload)).toContain('📊 Status');
    expect(JSON.stringify(mainPayload)).toContain('❤️ Health');

    await harness.bot.handleUpdate(callbackUpdate(2, OWNER_ID, 'm:status'));
    expect(lastPayload(harness.callApi, 'editMessageText')?.text).toContain(
      'Auto WTB Bot Status',
    );
    await harness.bot.handleUpdate(callbackUpdate(3, OWNER_ID, 'm:health'));
    expect(lastPayload(harness.callApi, 'editMessageText')?.text).toContain('Health');

    await harness.bot.handleUpdate(callbackUpdate(4, OWNER_ID, 'm:accounts'));
    const accountsPayload = lastPayload(harness.callApi, 'editMessageText');
    expect(accountsPayload?.text).toContain('Telegram Accounts');
    expect(JSON.stringify(accountsPayload)).toContain('⚙️ Manage Primary');
    expect(JSON.stringify(accountsPayload)).toContain('➕ Add Account');
    expect(JSON.stringify(accountsPayload)).toContain('🔄 Refresh');
    expect(JSON.stringify(accountsPayload)).toContain('⬅️ Back');

    const listCalls = harness.controller.listCalls;
    await harness.bot.handleUpdate(callbackUpdate(5, OWNER_ID, 'm:accounts'));
    expect(harness.controller.listCalls).toBe(listCalls + 1);
    await harness.bot.handleUpdate(callbackUpdate(6, OWNER_ID, 'm:main'));
    expect(lastPayload(harness.callApi, 'editMessageText')?.text).toContain(
      'Choose an option',
    );
    await harness.close();
  });

  it('completes Add Account through nickname, phone, OTP, 2FA, and returns to detail buttons', async () => {
    const harness = await createBotHarness();

    await harness.bot.handleUpdate(callbackUpdate(10, OWNER_ID, 'a:add'));
    expect(lastPayload(harness.callApi, 'editMessageText')?.text).toContain(
      'Choose a unique nickname',
    );
    expect(JSON.stringify(lastPayload(harness.callApi, 'editMessageText'))).toContain(
      '❌ Cancel',
    );

    await harness.bot.handleUpdate(callbackUpdate(11, OWNER_ID, 'flow:cancel'));
    expect(lastPayload(harness.callApi, 'editMessageText')?.text).toContain(
      'Add account cancelled',
    );
    await harness.bot.handleUpdate(callbackUpdate(12, OWNER_ID, 'a:add'));

    await harness.bot.handleUpdate(textUpdate(13, OWNER_ID, 'Sales Jakarta'));
    expect(lastPayload(harness.callApi, 'sendMessage')?.text).toContain(
      'Send the phone number',
    );

    await harness.bot.handleUpdate(textUpdate(14, OWNER_ID, '+628123456789'));
    expect(harness.controller.addedNickname).toBe('Sales Jakarta');
    expect(harness.controller.addedPhone).toBe('+628123456789');
    expect(lastPayload(harness.callApi, 'sendMessage')?.text).toContain('OTP Requested');

    await harness.bot.handleUpdate(textUpdate(15, OWNER_ID, '654321'));
    expect(harness.controller.submittedOtp).toBe('654321');
    expect(lastPayload(harness.callApi, 'sendMessage')?.text).toContain(
      'Two-Factor Authentication',
    );

    await harness.bot.handleUpdate(textUpdate(16, OWNER_ID, 'temporary-2fa'));
    expect(harness.controller.submittedPassword).toBe('temporary-2fa');
    const detailPayload = lastPayload(harness.callApi, 'sendMessage');
    expect(detailPayload?.text).toContain('Login successful');
    expect(detailPayload?.text).toContain('Account Detail');
    expect(JSON.stringify(detailPayload)).toContain('🔄 Reconnect');
    expect(JSON.stringify(detailPayload)).toContain('🔐 Login');
    expect(JSON.stringify(detailPayload)).toContain('🔌 Disconnect');
    expect(JSON.stringify(detailPayload)).toContain('▶️ Enable');
    expect(JSON.stringify(detailPayload)).toContain('⏸ Disable');
    expect(JSON.stringify(detailPayload)).toContain('✏️ Rename');
    expect(JSON.stringify(detailPayload)).toContain('💬 Reply Templates');
    expect(JSON.stringify(detailPayload)).toContain('🗑 Remove');
    expect(JSON.stringify(detailPayload)).toContain('⬅️ Back');

    const deletedMessages = methodCalls(harness.callApi, 'deleteMessage');
    expect(deletedMessages).toHaveLength(3);
    expect(JSON.stringify(harness.callApi.mock.calls)).not.toContain('temporary-2fa');
    await harness.close();
  });

  it('manages an account with buttons and requires button confirmation to remove', async () => {
    const harness = await createBotHarness();

    await harness.bot.handleUpdate(callbackUpdate(20, OWNER_ID, `a:o:${FIRST_KEY}`));
    expect(lastPayload(harness.callApi, 'editMessageText')?.text).toContain(
      'Account Detail',
    );
    expect(lastPayload(harness.callApi, 'editMessageText')?.text).toContain(
      'Nickname: Primary',
    );
    expect(lastPayload(harness.callApi, 'editMessageText')?.text).toContain(
      '+628***501',
    );

    await harness.bot.handleUpdate(callbackUpdate(21, OWNER_ID, `a:rn:${FIRST_KEY}`));
    expect(lastPayload(harness.callApi, 'editMessageText')?.text).toContain(
      'Rename Account',
    );
    await harness.bot.handleUpdate(textUpdate(22, OWNER_ID, 'Operations'));
    expect(harness.controller.renameCalls).toEqual([
      { accountKey: FIRST_KEY, nickname: 'Operations' },
    ]);
    expect(lastPayload(harness.callApi, 'sendMessage')?.text).toContain(
      'Nickname: Operations',
    );

    await harness.bot.handleUpdate(callbackUpdate(23, OWNER_ID, `a:rc:${FIRST_KEY}`));
    await harness.bot.handleUpdate(callbackUpdate(24, OWNER_ID, `a:dc:${FIRST_KEY}`));
    await harness.bot.handleUpdate(callbackUpdate(25, OWNER_ID, `a:en:${FIRST_KEY}`));
    await harness.bot.handleUpdate(callbackUpdate(26, OWNER_ID, `a:di:${FIRST_KEY}`));
    expect(harness.controller.reconnectCalls).toEqual([FIRST_KEY]);
    expect(harness.controller.disconnectCalls).toEqual([FIRST_KEY]);
    expect(harness.controller.enableCalls).toEqual([FIRST_KEY]);
    expect(harness.controller.disableCalls).toEqual([FIRST_KEY]);

    await harness.bot.handleUpdate(callbackUpdate(27, OWNER_ID, `a:rm:${FIRST_KEY}`));
    const confirmation = lastPayload(harness.callApi, 'editMessageText');
    expect(confirmation?.text).toContain('Remove Account?');
    expect(JSON.stringify(confirmation)).toContain('⚠️ Yes, Remove');
    expect(JSON.stringify(confirmation)).toContain('❌ Cancel');
    expect(harness.controller.removeCalls).toHaveLength(0);

    await harness.bot.handleUpdate(callbackUpdate(28, OWNER_ID, `a:no:${FIRST_KEY}`));
    expect(harness.controller.removeCalls).toHaveLength(0);
    expect(lastPayload(harness.callApi, 'editMessageText')?.text).toContain(
      'Account Detail',
    );

    await harness.bot.handleUpdate(callbackUpdate(29, OWNER_ID, `a:rm:${FIRST_KEY}`));
    await harness.bot.handleUpdate(callbackUpdate(30, OWNER_ID, `a:yes:${FIRST_KEY}`));
    expect(harness.controller.removeCalls).toEqual([FIRST_KEY]);
    expect(lastPayload(harness.callApi, 'editMessageText')?.text).toContain(
      'Account removed',
    );
    await harness.close();
  });

  it('rejects non-owner callbacks before any menu or account action runs', async () => {
    const harness = await createBotHarness();
    const listCalls = harness.controller.listCalls;

    await harness.bot.handleUpdate(
      callbackUpdate(31, 987654321, `a:rn:${FIRST_KEY}`),
    );
    await harness.bot.handleUpdate(callbackUpdate(32, 987654321, 'g:tr'));

    expect(harness.controller.listCalls).toBe(listCalls);
    expect(harness.controller.renameCalls).toHaveLength(0);
    expect(harness.keywords.triggerKeywords).toEqual([]);
    expect(lastPayload(harness.callApi, 'answerCallbackQuery')).toMatchObject({
      text: '⛔ Access denied.',
      show_alert: true,
    });
    expect(methodCalls(harness.callApi, 'editMessageText')).toHaveLength(0);
    await harness.close();
  });

  it('runs the owner-only channel button flow with account validation and remove confirmation', async () => {
    const harness = await createBotHarness();
    await harness.bot.handleUpdate(commandUpdate(40, OWNER_ID, '/start'));
    expect(JSON.stringify(lastPayload(harness.callApi, 'sendMessage'))).toContain('📡 Channels');

    await harness.bot.handleUpdate(callbackUpdate(41, OWNER_ID, 'm:channels'));
    expect(lastPayload(harness.callApi, 'editMessageText')?.text).toContain('No channels');
    await harness.bot.handleUpdate(callbackUpdate(42, OWNER_ID, 'c:add'));
    expect(lastPayload(harness.callApi, 'editMessageText')?.text).toContain('No account will be joined');
    await harness.bot.handleUpdate(textUpdate(43, OWNER_ID, '@sharedchannel'));
    expect(lastPayload(harness.callApi, 'sendMessage')?.text).toContain('Choose the Telegram account');
    await harness.bot.handleUpdate(callbackUpdate(44, OWNER_ID, 'c:pick:1'));
    expect(harness.channels.added).toEqual({ identifier: '@sharedchannel', accountKey: FIRST_KEY });
    const detail = lastPayload(harness.callApi, 'editMessageText');
    expect(detail?.text).toContain('Channel validated and saved');
    expect(JSON.stringify(detail)).toContain('Monitoring Accounts');
    expect(JSON.stringify(detail)).toContain('🔄 Refresh');

    await harness.bot.handleUpdate(callbackUpdate(45, OWNER_ID, 'c:rm:1'));
    expect(JSON.stringify(lastPayload(harness.callApi, 'editMessageText'))).toContain('Yes, Remove');
    expect(harness.channels.removed).toEqual([]);
    await harness.bot.handleUpdate(callbackUpdate(46, OWNER_ID, 'c:o:1'));
    expect(harness.channels.removed).toEqual([]);
    await harness.bot.handleUpdate(callbackUpdate(47, OWNER_ID, 'c:rm:1'));
    await harness.bot.handleUpdate(callbackUpdate(48, OWNER_ID, 'c:yes:1'));
    expect(harness.channels.removed).toEqual([1]);

    await harness.bot.handleUpdate(callbackUpdate(49, 987654321, 'm:channels'));
    expect(lastPayload(harness.callApi, 'answerCallbackQuery')).toMatchObject({
      text: '⛔ Access denied.',
      show_alert: true,
    });
    await harness.close();
  });

  it('runs button-first reply template and rule flows and rejects non-owner rule callbacks', async () => {
    const harness = await createBotHarness();
    harness.channels.channels = [testChannel()];
    harness.channels.assignments = [
      testAssignment(1, harness.controller.getAccount(FIRST_KEY), 1),
    ];

    await harness.bot.handleUpdate(commandUpdate(60, OWNER_ID, '/start'));
    const main = JSON.stringify(lastPayload(harness.callApi, 'sendMessage'));
    expect(main).toContain('📋 Rules');
    expect(main).toContain('📝 Reply Templates');

    await harness.bot.handleUpdate(callbackUpdate(601, OWNER_ID, 'm:rules'));
    const rulesMenu = JSON.stringify(lastPayload(harness.callApi, 'editMessageText'));
    expect(rulesMenu).toContain('🎯 Trigger Keywords');
    expect(rulesMenu).toContain('🚫 Exclude Keywords');
    expect(rulesMenu).toContain('🧹 Cleanup Patterns');
    expect(rulesMenu).toContain('💬 Reply Templates');
    expect(rulesMenu).toContain('⚙️ Settings / Status');
    expect(rulesMenu).toContain('⬅️ Back');

    await harness.bot.handleUpdate(callbackUpdate(602, OWNER_ID, 'g:tr'));
    await harness.bot.handleUpdate(textUpdate(603, OWNER_ID, ' Bucin, mensive, , BULOL '));
    expect(harness.keywords.triggerKeywords).toEqual(['bucin', 'mensive', 'bulol']);
    await harness.bot.handleUpdate(callbackUpdate(604, OWNER_ID, 'g:ex'));
    await harness.bot.handleUpdate(textUpdate(605, OWNER_ID, ' FMV, channel, ch '));
    expect(harness.keywords.excludeKeywords).toEqual(['fmv', 'channel', 'ch']);
    await harness.bot.handleUpdate(callbackUpdate(606, OWNER_ID, 'g:cl'));
    await harness.bot.handleUpdate(textUpdate(607, OWNER_ID, 'JGN REPLY, NO REPLY'));
    expect(harness.keywords.cleanupPatterns).toEqual(['jgn reply', 'no reply']);
    await harness.bot.handleUpdate(callbackUpdate(608, OWNER_ID, 'g:st'));
    expect(lastPayload(harness.callApi, 'editMessageText')?.text).toContain(
      'Rules Settings / Status',
    );
    await harness.bot.handleUpdate(callbackUpdate(609, OWNER_ID, 'g:di'));
    expect(harness.keywords.enabled).toBe(false);

    await harness.bot.handleUpdate(callbackUpdate(61, OWNER_ID, 'm:templates'));
    expect(lastPayload(harness.callApi, 'editMessageText')?.text).toContain(
      'Choose the Telegram account',
    );
    await harness.bot.handleUpdate(callbackUpdate(611, OWNER_ID, `a:tp:${FIRST_KEY}`));
    expect(lastPayload(harness.callApi, 'editMessageText')?.text).toContain(
      'Account: Primary',
    );
    await harness.bot.handleUpdate(callbackUpdate(62, OWNER_ID, `t:add:${FIRST_KEY}`));
    await harness.bot.handleUpdate(textUpdate(63, OWNER_ID, 'Main Reply'));
    await harness.bot.handleUpdate(textUpdate(64, OWNER_ID, 'Please DM me.'));
    expect(harness.templates.templates).toEqual([
      expect.objectContaining({
        accountKey: FIRST_KEY,
        name: 'Main Reply',
        body: 'Please DM me.',
      }),
    ]);
    const templateDetail = lastPayload(harness.callApi, 'sendMessage');
    expect(JSON.stringify(templateDetail)).toContain('✏️ Edit');
    expect(JSON.stringify(templateDetail)).toContain('🗑 Delete');

    harness.controller.accounts.push(testAccount(
      ADDED_KEY,
      'Secondary',
      '+628999999999',
    ));
    await harness.bot.handleUpdate(
      callbackUpdate(641, OWNER_ID, `t:o:${ADDED_KEY}:1`),
    );
    expect(lastPayload(harness.callApi, 'sendMessage')?.text).toContain(
      'Operation failed: Template not found',
    );

    await harness.bot.handleUpdate(callbackUpdate(65, OWNER_ID, 'm:rules'));
    await harness.bot.handleUpdate(callbackUpdate(66, OWNER_ID, 'r:add'));
    await harness.bot.handleUpdate(textUpdate(67, OWNER_ID, 'Bucin Rule'));
    expect(JSON.stringify(lastPayload(harness.callApi, 'sendMessage'))).toContain('r:ch:1');
    await harness.bot.handleUpdate(callbackUpdate(68, OWNER_ID, 'r:ch:1'));
    await harness.bot.handleUpdate(textUpdate(69, OWNER_ID, 'bucin, wtb'));
    await harness.bot.handleUpdate(textUpdate(70, OWNER_ID, 'fmv'));
    await harness.bot.handleUpdate(textUpdate(71, OWNER_ID, '-'));
    expect(JSON.stringify(lastPayload(harness.callApi, 'sendMessage'))).toContain('r:tp:1');
    await harness.bot.handleUpdate(callbackUpdate(72, OWNER_ID, 'r:tp:1'));
    expect(harness.rules.rules).toEqual([
      expect.objectContaining({
        name: 'Bucin Rule',
        channelId: 1,
        triggerKeywords: ['bucin', 'wtb'],
        excludeKeywords: ['fmv'],
        cleanupSenderPatterns: ['JGN REPLY'],
        replyTemplateId: 1,
      }),
    ]);
    const ruleDetail = lastPayload(harness.callApi, 'editMessageText');
    expect(ruleDetail?.text).toContain('Rule created');
    expect(ruleDetail?.text).toContain('Cleanup sender: JGN REPLY');
    expect(JSON.stringify(ruleDetail)).toContain('✅ Enable');
    expect(JSON.stringify(ruleDetail)).toContain('🔄 Refresh');

    await harness.bot.handleUpdate(callbackUpdate(73, OWNER_ID, 'r:en:1'));
    expect(harness.rules.get(1).enabled).toBe(true);
    await harness.bot.handleUpdate(callbackUpdate(74, OWNER_ID, 'r:rm:1'));
    expect(JSON.stringify(lastPayload(harness.callApi, 'editMessageText'))).toContain('Yes, Delete');
    expect(harness.rules.rules).toHaveLength(1);

    await harness.bot.handleUpdate(callbackUpdate(75, 987654321, 'r:yes:1'));
    expect(harness.rules.rules).toHaveLength(1);
    expect(lastPayload(harness.callApi, 'answerCallbackQuery')).toMatchObject({
      text: '⛔ Access denied.',
      show_alert: true,
    });
    await harness.close();
  });

  it('runs owner-only M5 settings, channel resume, emergency controls, and reply notification UI', async () => {
    const harness = await createBotHarness();
    await harness.bot.handleUpdate(commandUpdate(800, OWNER_ID, '/start'));
    const main = lastPayload(harness.callApi, 'sendMessage');
    expect(JSON.stringify(main)).toContain('🚨 STOP ALL');
    expect(JSON.stringify(main)).toContain('▶️ RESUME ALL');

    await harness.bot.handleUpdate(callbackUpdate(801, OWNER_ID, `a:o:${FIRST_KEY}`));
    const account = lastPayload(harness.callApi, 'editMessageText');
    expect(JSON.stringify(account)).toContain('⏱ Reply Delay');
    expect(JSON.stringify(account)).toContain('❤️ Auto Reaction');
    expect(JSON.stringify(account)).toContain('⚙️ Auto Reply Settings');
    expect(JSON.stringify(account)).toContain('📊 Limits');

    await harness.bot.handleUpdate(callbackUpdate(802, OWNER_ID, `a:delay:${FIRST_KEY}`));
    expect(lastPayload(harness.callApi, 'editMessageText')?.text).toContain('0 to 600');
    await harness.bot.handleUpdate(textUpdate(803, OWNER_ID, '7.25'));
    expect(harness.automationSettings.get(FIRST_KEY).replyDelayMs).toBe(7_250);

    await harness.bot.handleUpdate(callbackUpdate(804, OWNER_ID, `a:reaction:${FIRST_KEY}`));
    await harness.bot.handleUpdate(callbackUpdate(805, OWNER_ID, `a:re:on:${FIRST_KEY}`));
    expect(harness.automationSettings.get(FIRST_KEY).autoReaction).toBe(true);

    await harness.bot.handleUpdate(callbackUpdate(806, OWNER_ID, `a:hour:${FIRST_KEY}`));
    await harness.bot.handleUpdate(textUpdate(807, OWNER_ID, '4'));
    await harness.bot.handleUpdate(callbackUpdate(808, OWNER_ID, `a:day:${FIRST_KEY}`));
    await harness.bot.handleUpdate(textUpdate(809, OWNER_ID, '12'));
    expect(harness.automationSettings.get(FIRST_KEY)).toMatchObject({
      hourlyLimit: 4,
      dailyLimit: 12,
    });
    await harness.bot.handleUpdate(callbackUpdate(8091, OWNER_ID, `a:notify:${FIRST_KEY}`));
    await harness.bot.handleUpdate(textUpdate(8092, OWNER_ID, '@MonitoringBot'));
    expect(harness.automationSettings.get(FIRST_KEY).notificationTarget).toBe('@MonitoringBot');

    harness.channels.channels = [{
      ...testChannel(),
      automationBlocked: true,
      blockedReason: 'cleanup_sender_pattern:jgn reply',
    }];
    await harness.bot.handleUpdate(callbackUpdate(810, OWNER_ID, 'c:o:1'));
    const blocked = lastPayload(harness.callApi, 'editMessageText');
    expect(blocked?.text).toContain('🚫 BLOCKED');
    expect(JSON.stringify(blocked)).toContain('▶️ Resume');
    await harness.bot.handleUpdate(callbackUpdate(811, OWNER_ID, 'c:resume:1'));
    expect(harness.automationSafety.resumedChannels).toEqual([1]);

    await harness.bot.handleUpdate(callbackUpdate(812, 987654321, 'auto:stop'));
    expect(harness.automationSafety.stopCalls).toBe(0);
    await harness.bot.handleUpdate(callbackUpdate(813, OWNER_ID, 'auto:stop'));
    await harness.bot.handleUpdate(callbackUpdate(814, OWNER_ID, 'auto:stop:yes'));
    expect(harness.automationSafety.stopCalls).toBe(1);
    await harness.bot.handleUpdate(callbackUpdate(815, OWNER_ID, 'auto:resume'));
    expect(harness.automationSafety.resumeCalls).toBe(1);

    await harness.service.notifyOwner({
      type: 'cleanup_blocked',
      channelTitle: 'Shared Channel',
      pattern: 'jgn reply',
    });
    const notification = lastPayload(harness.callApi, 'sendMessage');
    expect(notification?.text).toContain('CHANNEL AUTOMATION BLOCKED');
    expect(notification?.text).toContain('jgn reply');
    await harness.close();
  });
});

async function createBotHarness(): Promise<{
  readonly service: AdminBotService;
  readonly bot: Telegraf;
  readonly controller: FakeAccountController;
  readonly channels: FakeChannelController;
  readonly rules: FakeRuleController;
  readonly templates: FakeTemplateController;
  readonly keywords: FakeGlobalKeywordController;
  readonly automationSettings: FakeAutomationSettingsController;
  readonly automationSafety: FakeAutomationSafetyController;
  readonly callApi: MockInstance;
  readonly logger: LoggerHandle;
  close(): Promise<void>;
}> {
  const logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-wtb-admin-ui-'));
  const logger = createLogger({
    level: 'error',
    logDirectory,
    environment: 'test',
    writeToStdout: false,
  });
  const controller = new FakeAccountController();
  const channels = new FakeChannelController(controller);
  const rules = new FakeRuleController();
  const templates = new FakeTemplateController();
  const keywords = new FakeGlobalKeywordController();
  const automationSettings = new FakeAutomationSettingsController(controller);
  const automationSafety = new FakeAutomationSafetyController(channels);
  let capturedBot: Telegraf | undefined;
  const lifecycle: AdminBotLifecycleAdapter = {
    launch(bot): Promise<void> {
      capturedBot = bot;
      return Promise.resolve();
    },
    stop(): void {},
  };
  const service = new AdminBotService(
    {
      token: '123456:test-token',
      ownerTelegramId: String(OWNER_ID),
      logger: logger.logger,
      statusProvider: () => ({
        service: 'auto-wtb-bot',
        state: 'running',
        uptimeSeconds: 42,
        migrationVersion: 6,
        registeredTelegramClients: 1,
        connectedTelegramClients: 1,
      }),
      accountController: controller,
      channelController: channels,
      ruleController: rules,
      replyTemplateController: templates,
      keywordController: keywords,
      automationSettingsController: automationSettings,
      automationSafetyController: automationSafety,
    },
    lifecycle,
  );
  await service.start();

  if (capturedBot === undefined) throw new Error('Test bot was not captured');
  capturedBot.botInfo = {
    id: 123456,
    is_bot: true,
    first_name: 'Auto WTB Test',
    username: 'auto_wtb_test_bot',
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };
  const callApi = vi
    .spyOn(Telegram.prototype, 'callApi')
    .mockResolvedValue({ message_id: 999 });

  return {
    service,
    bot: capturedBot,
    controller,
    channels,
    rules,
    templates,
    keywords,
    automationSettings,
    automationSafety,
    callApi,
    logger,
    async close(): Promise<void> {
      await service.stop('test complete');
      callApi.mockRestore();
      logger.close();
    },
  };
}

function testChannel(): ChannelRecord {
  return {
    id: 1,
    telegramChannelId: '100700',
    username: 'sharedchannel',
    title: 'Shared Channel',
    enabled: true,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function testAssignment(id: number, account: AccountRecord, channelId: number): ChannelAssignmentRecord {
  return {
    id,
    accountId: account.id,
    accountKey: account.accountKey,
    accountNickname: account.nickname,
    channelId,
    enabled: true,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function testTemplate(
  id: number,
  accountKey: string,
  name: string,
  body: string,
): ReplyTemplateRecord {
  return {
    id,
    accountId: accountKey === FIRST_KEY ? 1 : 2,
    accountKey,
    accountNickname: accountKey === FIRST_KEY ? 'Primary' : 'Secondary',
    name,
    body,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function testRule(id: number, input: RuleInput): RuleRecord {
  return {
    id,
    ownerId: 1,
    channelId: input.channelId,
    channelTitle: 'Shared Channel',
    ...(input.replyTemplateId === undefined
      ? {}
      : { replyTemplateId: input.replyTemplateId, replyTemplateName: 'Main Reply' }),
    name: input.name,
    triggerKeywords: input.triggerKeywords,
    excludeKeywords: input.excludeKeywords,
    cleanupSenderPatterns: input.cleanupSenderPatterns,
    enabled: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function testAccount(
  accountKey: string,
  label: string,
  phoneNumber = '+628111111501',
  enabled = true,
): AccountRecord {
  return {
    id: accountKey === FIRST_KEY ? 1 : 2,
    ownerId: 1,
    accountKey,
    nickname: label,
    label,
    phoneNumber,
    status: enabled ? 'connected' : 'disconnected',
    enabled,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function commandUpdate(updateId: number, userId: number, text: string) {
  const command = text.split(' ')[0] ?? text;
  return {
    update_id: updateId,
    message: message(updateId, userId, text, [
      { offset: 0, length: command.length, type: 'bot_command' as const },
    ]),
  };
}

function textUpdate(updateId: number, userId: number, text: string) {
  return {
    update_id: updateId,
    message: message(updateId, userId, text),
  };
}

function callbackUpdate(updateId: number, userId: number, data: string) {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: telegramUser(userId),
      chat_instance: 'test-chat-instance',
      data,
      message: message(updateId, userId, 'Admin menu'),
    },
  };
}

function message(
  messageId: number,
  userId: number,
  text: string,
  entities?: Array<{
    readonly offset: number;
    readonly length: number;
    readonly type: 'bot_command';
  }>,
) {
  return {
    message_id: messageId,
    date: 1_700_000_000,
    chat: { id: userId, type: 'private' as const, first_name: 'Test Owner' },
    from: telegramUser(userId),
    text,
    ...(entities === undefined ? {} : { entities }),
  };
}

function telegramUser(userId: number) {
  return { id: userId, is_bot: false, first_name: 'Test Owner' };
}

function methodCalls(callApi: MockInstance, method: string): unknown[][] {
  return callApi.mock.calls.filter(([calledMethod]) => calledMethod === method);
}

function lastPayload(
  callApi: MockInstance,
  method: string,
): Record<string, unknown> | undefined {
  const calls = methodCalls(callApi, method);
  const call = calls.at(-1);
  return call?.[1] as Record<string, unknown> | undefined;
}

function parseKeywords(value: string): string[] {
  return [...new Set(value
    .split(',')
    .map((keyword) => keyword.trim().replace(/\s+/g, ' ').toLocaleLowerCase('id-ID'))
    .filter((keyword) => keyword.length > 0))];
}
