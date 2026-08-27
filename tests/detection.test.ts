import { describe, it, expect, vi } from 'vitest';
import { DetectionEngine, normalizeText, findFirstMatch, findAllMatches, findFirstSenderPatternMatch } from '../src/detection/detection.engine.js';
import { DispatchPlanner } from '../src/detection/dispatch.planner.js';
import type { TelegramSenderDisplayName, TelegramIncomingMessage } from '../src/rules/rule.types.js';
import type { ChannelRecord } from '../src/channels/channel.types.js';
import type { ChannelRepository } from '../src/channels/channel.repository.js';
import type { AppLogger } from '../src/logging/logger.js';
import type { ChannelAssignmentRecord } from '../src/channels/channel.types.js';

const mockLogger: AppLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as AppLogger;

describe('detection engine', () => {
  it('matches trigger keyword', () => {
    const engine = new DetectionEngine();
    const result = engine.evaluate(
      { text: 'bucin mensive anniversary' },
      {
        enabled: true,
        triggerKeywords: ['bucin'],
        excludeKeywords: [],
        cleanupPatterns: [],
      },
    );
    expect(result.status).toBe('MATCH');
    expect(result.reason).toBe('trigger_match');
    expect(result.matchedTriggers).toContain('bucin');
  });

  it('is case-insensitive for trigger keywords', () => {
    const engine = new DetectionEngine();
    const result = engine.evaluate(
      { text: 'BUCIN MENSIVE' },
      {
        enabled: true,
        triggerKeywords: ['bucin', 'mensive'],
        excludeKeywords: [],
        cleanupPatterns: [],
      },
    );
    expect(result.status).toBe('MATCH');
    expect(result.matchedTriggers).toContain('bucin');
  });

  it('returns multiple matched trigger keywords', () => {
    const engine = new DetectionEngine();
    const result = engine.evaluate(
      { text: 'bucin mensive anniversary' },
      {
        enabled: true,
        triggerKeywords: ['bucin', 'mensive', 'anniversary'],
        excludeKeywords: [],
        cleanupPatterns: [],
      },
    );
    expect(result.status).toBe('MATCH');
    expect(result.matchedTriggers).toHaveLength(3);
    expect(result.matchedTriggers).toEqual(['bucin', 'mensive', 'anniversary']);
  });

  it('ignores post with no trigger match', () => {
    const engine = new DetectionEngine();
    const result = engine.evaluate(
      { text: 'just a random post' },
      {
        enabled: true,
        triggerKeywords: ['bucin', 'mensive'],
        excludeKeywords: [],
        cleanupPatterns: [],
      },
    );
    expect(result.status).toBe('IGNORE');
    expect(result.reason).toBe('no_trigger_match');
    expect(result.matchedTriggers).toEqual([]);
  });

  it('blocks post with exclude keyword even if trigger matches', () => {
    const engine = new DetectionEngine();
    const result = engine.evaluate(
      { text: 'bucin jangan reply' },
      {
        enabled: true,
        triggerKeywords: ['bucin'],
        excludeKeywords: ['jangan reply'],
        cleanupPatterns: [],
      },
    );
    expect(result.status).toBe('BLOCK');
    expect(result.reason).toBe('exclude_match');
    expect(result.matchedExcludeKeywords).toContain('jangan reply');
    expect(result.matchedTriggers).toEqual([]);
  });

  it('is case-insensitive for exclude keywords', () => {
    const engine = new DetectionEngine();
    const result = engine.evaluate(
      { text: 'BUCIN JANGAN REPLY' },
      {
        enabled: true,
        triggerKeywords: ['bucin'],
        excludeKeywords: ['jangan reply'],
        cleanupPatterns: [],
      },
    );
    expect(result.status).toBe('BLOCK');
    expect(result.matchedExcludeKeywords).toContain('jangan reply');
  });

  it('blocks post with sender display-name pattern match', () => {
    const engine = new DetectionEngine();
    const result = engine.evaluate(
      {
        text: 'bucin',
        senderDisplayName: '‼️JGN REPLY‼️',
        senderDisplayNames: [{ source: 'from_id_sender', value: '‼️JGN REPLY‼️' }],
      },
      {
        enabled: true,
        triggerKeywords: ['bucin'],
        excludeKeywords: [],
        cleanupPatterns: ['JGN REPLY'],
      },
    );
    expect(result.status).toBe('BLOCK');
    expect(result.reason).toBe('sender_pattern_match');
    expect(result.matchedSenderPatterns).toContain('JGN REPLY');
  });

  it('is case-insensitive for sender patterns', () => {
    const engine = new DetectionEngine();
    const result = engine.evaluate(
      {
        text: 'bucin',
        senderDisplayNames: [{ source: 'from_id_sender', value: 'jgn reply' }],
      },
      {
        enabled: true,
        triggerKeywords: ['bucin'],
        excludeKeywords: [],
        cleanupPatterns: ['JGN REPLY'],
      },
    );
    expect(result.status).toBe('BLOCK');
    expect(result.matchedSenderPatterns).toContain('JGN REPLY');
  });

  it('applies deterministic precedence: exclude before sender pattern', () => {
    const engine = new DetectionEngine();
    const result = engine.evaluate(
      {
        text: 'bucin jangan',
        senderDisplayNames: [{ source: 'from_id_sender', value: 'JGN REPLY' }],
      },
      {
        enabled: true,
        triggerKeywords: ['bucin'],
        excludeKeywords: ['jangan'],
        cleanupPatterns: ['JGN REPLY'],
      },
    );
    expect(result.status).toBe('BLOCK');
    expect(result.reason).toBe('exclude_match');
    expect(result.matchedExcludeKeywords).toContain('jangan');
  });

  it('applies deterministic precedence: sender pattern before trigger', () => {
    const engine = new DetectionEngine();
    const result = engine.evaluate(
      {
        text: 'bucin',
        senderDisplayNames: [{ source: 'from_id_sender', value: 'JGN REPLY' }],
      },
      {
        enabled: true,
        triggerKeywords: ['bucin'],
        excludeKeywords: [],
        cleanupPatterns: ['JGN REPLY'],
      },
    );
    expect(result.status).toBe('BLOCK');
    expect(result.reason).toBe('sender_pattern_match');
  });

  it('ignores when detection is disabled', () => {
    const engine = new DetectionEngine();
    const result = engine.evaluate(
      { text: 'bucin' },
      {
        enabled: false,
        triggerKeywords: ['bucin'],
        excludeKeywords: [],
        cleanupPatterns: [],
      },
    );
    expect(result.status).toBe('IGNORE');
  });

  it('normalizes text correctly', () => {
    expect(normalizeText('BUCIN')).toBe('bucin');
    expect(normalizeText('bucin!!!mensive??')).toBe('bucin mensive');
    expect(normalizeText('  bucin   mensive  ')).toBe('bucin mensive');
    // Unicode normalization handles combining diacritics
    expect(normalizeText('BüCïN')).toBe('bücïn');
  });

  it('findFirstMatch returns first matching keyword', () => {
    const match = findFirstMatch('bucin mensive', ['mensive', 'bucin']);
    expect(match).toBe('mensive');
  });

  it('findAllMatches returns all matching keywords in order', () => {
    const matches = findAllMatches('bucin mensive anniversary', ['bucin', 'mensive', 'anniversary']);
    expect(matches).toEqual(['bucin', 'mensive', 'anniversary']);
  });

  it('findAllMatches skips non-matching keywords', () => {
    const matches = findAllMatches('bucin anniversary', ['bucin', 'mensive', 'anniversary']);
    expect(matches).toEqual(['bucin', 'anniversary']);
  });

  it('findFirstSenderPatternMatch finds pattern in sender display names', () => {
    const senders: TelegramSenderDisplayName[] = [
      { source: 'post_author', value: 'Author' },
      { source: 'from_id_sender', value: '‼️JGN REPLY‼️' },
    ];
    const match = findFirstSenderPatternMatch(senders, ['JGN REPLY', 'BOT']);
    expect(match).toBe('JGN REPLY');
  });
});

describe('dispatch planner', () => {
  function createMockChannel(): ChannelRecord {
    return {
      id: 1,
      telegramChannelId: '1001001',
      title: 'Test Channel',
      enabled: true,
      status: 'healthy',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  function createMockAssignment(accountId: number): ChannelAssignmentRecord {
    return {
      id: accountId,
      accountId,
      accountKey: `account-${accountId}`,
      accountNickname: `Account ${accountId}`,
      channelId: 1,
      enabled: true,
      status: 'healthy',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  it('creates one job per eligible assigned account', () => {
    const mockChannels = {
      listEffectiveAssignmentsForChannel: vi.fn().mockReturnValue([
        { assignment: createMockAssignment(1), channel: createMockChannel() },
        { assignment: createMockAssignment(2), channel: createMockChannel() },
      ]),
    } as unknown as ChannelRepository;

    const planner = new DispatchPlanner(mockChannels, mockLogger);
    const jobs = planner.plan({
      detection: {
        status: 'MATCH',
        reason: 'trigger_match',
        matchedTriggers: ['bucin'],
        matchedExcludeKeywords: [],
        matchedSenderPatterns: [],
      },
      source: {
        chatKind: 'channel_post',
        sourceMessageId: 100,
        text: 'bucin',
        senderDisplayName: 'Test User',
        telegramChannelId: '1001001',
      } as unknown as TelegramIncomingMessage,
      channel: createMockChannel(),
      automationEnabled: true,
      ownerTelegramId: 'owner-1',
    });

    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.accountId).toBe(1);
    expect(jobs[1]?.accountId).toBe(2);
  });

  it('creates three jobs for three eligible accounts', () => {
    const mockChannels = {
      listEffectiveAssignmentsForChannel: vi.fn().mockReturnValue([
        { assignment: createMockAssignment(1), channel: createMockChannel() },
        { assignment: createMockAssignment(2), channel: createMockChannel() },
        { assignment: createMockAssignment(3), channel: createMockChannel() },
      ]),
    } as unknown as ChannelRepository;

    const planner = new DispatchPlanner(mockChannels, mockLogger);
    const jobs = planner.plan({
      detection: {
        status: 'MATCH',
        reason: 'trigger_match',
        matchedTriggers: ['bucin'],
        matchedExcludeKeywords: [],
        matchedSenderPatterns: [],
      },
      source: {
        chatKind: 'channel_post',
        sourceMessageId: 100,
        text: 'bucin',
        senderDisplayName: 'Test',
        telegramChannelId: '1001001',
      } as unknown as TelegramIncomingMessage,
      channel: createMockChannel(),
      automationEnabled: true,
      ownerTelegramId: 'owner-1',
    });

    expect(jobs).toHaveLength(3);
    expect(jobs.map((j) => j.accountId)).toEqual([1, 2, 3]);
  });

  it('creates no jobs for unassigned account', () => {
    const mockChannels = {
      listEffectiveAssignmentsForChannel: vi.fn().mockReturnValue([]),
    } as unknown as ChannelRepository;

    const planner = new DispatchPlanner(mockChannels, mockLogger);
    const jobs = planner.plan({
      detection: {
        status: 'MATCH',
        reason: 'trigger_match',
        matchedTriggers: ['bucin'],
        matchedExcludeKeywords: [],
        matchedSenderPatterns: [],
      },
      source: {
        chatKind: 'channel_post',
        sourceMessageId: 100,
        text: 'bucin',
        senderDisplayName: 'Test',
        telegramChannelId: '1001001',
      } as unknown as TelegramIncomingMessage,
      channel: createMockChannel(),
      automationEnabled: true,
      ownerTelegramId: 'owner-1',
    });

    expect(jobs).toHaveLength(0);
  });

  it('preserves multiple matched triggers in all jobs', () => {
    const mockChannels = {
      listEffectiveAssignmentsForChannel: vi.fn().mockReturnValue([
        { assignment: createMockAssignment(1), channel: createMockChannel() },
        { assignment: createMockAssignment(2), channel: createMockChannel() },
      ]),
    } as unknown as ChannelRepository;

    const planner = new DispatchPlanner(mockChannels, mockLogger);
    const jobs = planner.plan({
      detection: {
        status: 'MATCH',
        reason: 'trigger_match',
        matchedTriggers: ['bucin', 'mensive', 'anniversary'],
        matchedExcludeKeywords: [],
        matchedSenderPatterns: [],
      },
      source: {
        chatKind: 'channel_post',
        sourceMessageId: 100,
        text: 'bucin mensive anniversary',
        senderDisplayName: 'Test',
        telegramChannelId: '1001001',
      } as unknown as TelegramIncomingMessage,
      channel: createMockChannel(),
      automationEnabled: true,
      ownerTelegramId: 'owner-1',
    });

    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.matchedTriggers).toEqual(['bucin', 'mensive', 'anniversary']);
    expect(jobs[1]?.matchedTriggers).toEqual(['bucin', 'mensive', 'anniversary']);
  });

  it('creates zero jobs for BLOCK detection', () => {
    const mockChannels = {
      listEffectiveAssignmentsForChannel: vi.fn().mockReturnValue([
        { assignment: createMockAssignment(1), channel: createMockChannel() },
      ]),
    } as unknown as ChannelRepository;

    const planner = new DispatchPlanner(mockChannels, mockLogger);
    const jobs = planner.plan({
      detection: {
        status: 'BLOCK',
        reason: 'exclude_match',
        matchedTriggers: [],
        matchedExcludeKeywords: ['jangan'],
        matchedSenderPatterns: [],
      },
      source: {
        chatKind: 'channel_post',
        sourceMessageId: 100,
        text: 'bucin jangan',
        senderDisplayName: 'Test',
        telegramChannelId: '1001001',
      } as unknown as TelegramIncomingMessage,
      channel: createMockChannel(),
      automationEnabled: true,
      ownerTelegramId: 'owner-1',
    });

    expect(jobs).toHaveLength(0);
  });

  it('creates zero jobs for IGNORE detection', () => {
    const mockChannels = {
      listEffectiveAssignmentsForChannel: vi.fn().mockReturnValue([
        { assignment: createMockAssignment(1), channel: createMockChannel() },
      ]),
    } as unknown as ChannelRepository;

    const planner = new DispatchPlanner(mockChannels, mockLogger);
    const jobs = planner.plan({
      detection: {
        status: 'IGNORE',
        reason: 'no_trigger_match',
        matchedTriggers: [],
        matchedExcludeKeywords: [],
        matchedSenderPatterns: [],
      },
      source: {
        chatKind: 'channel_post',
        sourceMessageId: 100,
        text: 'random',
        senderDisplayName: 'Test',
        telegramChannelId: '1001001',
      } as unknown as TelegramIncomingMessage,
      channel: createMockChannel(),
      automationEnabled: true,
      ownerTelegramId: 'owner-1',
    });

    expect(jobs).toHaveLength(0);
  });

  it('creates zero jobs when global automation is paused', () => {
    const mockChannels = {
      listEffectiveAssignmentsForChannel: vi.fn().mockReturnValue([
        { assignment: createMockAssignment(1), channel: createMockChannel() },
      ]),
    } as unknown as ChannelRepository;

    const planner = new DispatchPlanner(mockChannels, mockLogger);
    const jobs = planner.plan({
      detection: {
        status: 'MATCH',
        reason: 'trigger_match',
        matchedTriggers: ['bucin'],
        matchedExcludeKeywords: [],
        matchedSenderPatterns: [],
      },
      source: {
        chatKind: 'channel_post',
        sourceMessageId: 100,
        text: 'bucin',
        senderDisplayName: 'Test',
        telegramChannelId: '1001001',
      } as unknown as TelegramIncomingMessage,
      channel: createMockChannel(),
      automationEnabled: false,
      ownerTelegramId: 'owner-1',
    });

    expect(jobs).toHaveLength(0);
  });

  it('each job has correct structure with all required fields', () => {
    const mockChannels = {
      listEffectiveAssignmentsForChannel: vi.fn().mockReturnValue([
        { assignment: createMockAssignment(1), channel: createMockChannel() },
      ]),
    } as unknown as ChannelRepository;

    const planner = new DispatchPlanner(mockChannels, mockLogger);
    const jobs = planner.plan({
      detection: {
        status: 'MATCH',
        reason: 'trigger_match',
        matchedTriggers: ['bucin'],
        matchedExcludeKeywords: [],
        matchedSenderPatterns: [],
      },
      source: {
        chatKind: 'channel_post',
        sourceMessageId: 99,
        text: 'bucin post',
        senderDisplayName: 'User Name',
        telegramChannelId: '1001001',
      } as unknown as TelegramIncomingMessage,
      channel: createMockChannel(),
      automationEnabled: true,
      ownerTelegramId: 'owner-1',
    });

    expect(jobs).toHaveLength(1);
    const job = jobs[0];
    expect(job).toMatchObject({
      accountId: 1,
      channelId: 1,
      sourceMessageId: 99,
      matchedTriggers: ['bucin'],
      sourceText: 'bucin post',
      senderDisplayName: 'User Name',
    });
    expect(job?.timestamp).toBeInstanceOf(Date);
  });

  it('per-account deduplication: same source + different accounts creates separate jobs', () => {
    const mockChannels = {
      listEffectiveAssignmentsForChannel: vi.fn().mockReturnValue([
        { assignment: createMockAssignment(1), channel: createMockChannel() },
        { assignment: createMockAssignment(2), channel: createMockChannel() },
      ]),
    } as unknown as ChannelRepository;

    const planner = new DispatchPlanner(mockChannels, mockLogger);
    const jobs = planner.plan({
      detection: {
        status: 'MATCH',
        reason: 'trigger_match',
        matchedTriggers: ['bucin'],
        matchedExcludeKeywords: [],
        matchedSenderPatterns: [],
      },
      source: {
        chatKind: 'channel_post',
        sourceMessageId: 100,
        text: 'bucin',
        senderDisplayName: 'Test',
        telegramChannelId: '1001001',
      } as unknown as TelegramIncomingMessage,
      channel: createMockChannel(),
      automationEnabled: true,
      ownerTelegramId: 'owner-1',
    });

    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.accountId).toBe(1);
    expect(jobs[1]?.accountId).toBe(2);
    // Both have same sourceMessageId
    expect(jobs[0]?.sourceMessageId).toBe(100);
    expect(jobs[1]?.sourceMessageId).toBe(100);
  });
});
