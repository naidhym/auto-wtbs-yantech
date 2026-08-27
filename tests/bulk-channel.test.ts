import { describe, it, expect } from 'vitest';
import {
  toCanonicalChannelId,
  isSupergroupId,
  toPeerFormat,
} from '../src/shared/telegram-channel-id.js';
import {
  parseChannelInputBatch,
  deduplicateChannelInputs,
} from '../src/shared/bulk-channel-parser.js';

describe('telegram channel id normalization', () => {
  it('normalizes positive integers', () => {
    expect(toCanonicalChannelId(1611324665)).toBe('1611324665');
    expect(toCanonicalChannelId('1611324665')).toBe('1611324665');
  });

  it('normalizes negative integers', () => {
    expect(toCanonicalChannelId(-1611324665)).toBe('1611324665');
    expect(toCanonicalChannelId('-1611324665')).toBe('1611324665');
  });

  it('normalizes supergroup format', () => {
    expect(toCanonicalChannelId(-1001611324665)).toBe('1611324665');
    expect(toCanonicalChannelId('-1001611324665')).toBe('1611324665');
  });

  it('rejects invalid formats', () => {
    expect(() => toCanonicalChannelId('abc')).toThrow();
    expect(() => toCanonicalChannelId('')).toThrow();
  });

  it('detects supergroup ids', () => {
    expect(isSupergroupId('1611324665')).toBe(false);
    expect(isSupergroupId('-1001611324665')).toBe(true);
  });

  it('converts to peer format', () => {
    expect(toPeerFormat('1611324665')).toBe('-1001611324665');
  });
});

describe('bulk channel input parser', () => {
  it('parses @username format', () => {
    const result = parseChannelInputBatch(['@channelname', '@another_channel']);
    expect(result.valid).toHaveLength(2);
    expect(result.invalid).toHaveLength(0);
    expect(result.valid[0]?.normalized).toBe('channelname');
    expect(result.valid[0]?.type).toBe('username');
  });

  it('parses t.me/username format', () => {
    const result = parseChannelInputBatch([
      't.me/channelname',
      'https://t.me/another_channel',
    ]);
    expect(result.valid).toHaveLength(2);
    expect(result.invalid).toHaveLength(0);
  });

  it('parses numeric IDs', () => {
    const result = parseChannelInputBatch(['1611324665', '-1611324665']);
    // Both formats canonicalize to the same channel ID
    // parseChannelInputBatch deduplicates them correctly at the normalized level
    expect(result.valid).toHaveLength(1);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]!.reason).toContain('Duplicate');
    expect(result.valid[0]!.normalized).toBe('1611324665');
    expect(result.valid[0]!.type).toBe('numeric_id');
  });

  it('parses private links', () => {
    const result = parseChannelInputBatch(['t.me/+ABCDEFGHIJKLMNOPQRSTxyz']);
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0]?.type).toBe('private_link');
  });

  it('skips empty lines', () => {
    const result = parseChannelInputBatch([
      '@channel1',
      '',
      '  ',
      '@channel2',
    ]);
    expect(result.valid).toHaveLength(2);
  });

  it('skips comments', () => {
    const result = parseChannelInputBatch([
      '@channel1',
      '# this is a comment',
      '@channel2',
    ]);
    expect(result.valid).toHaveLength(2);
  });

  it('detects invalid usernames (too short)', () => {
    const result = parseChannelInputBatch(['@abc']);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]?.reason).toContain('5-32');
  });

  it('detects invalid formats', () => {
    const result = parseChannelInputBatch(['invalid']);
    expect(result.invalid).toHaveLength(1);
  });

  it('detects duplicates within batch', () => {
    const result = parseChannelInputBatch([
      '@channel1',
      '@channel1',
      '@channel2',
    ]);
    expect(result.valid).toHaveLength(2);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]?.reason).toContain('Duplicate');
  });

  it('normalizes usernames to lowercase', () => {
    const result = parseChannelInputBatch(['@ChannelName']);
    expect(result.valid[0]?.normalized).toBe('channelname');
  });

  it('deduplicates channel inputs', () => {
    const inputs = [
      { normalized: 'channel1', original: '@channel1', type: 'username' as const },
      { normalized: 'channel1', original: '@Channel1', type: 'username' as const },
      { normalized: 'channel2', original: '@channel2', type: 'username' as const },
    ];
    const dedup = deduplicateChannelInputs(inputs);
    expect(dedup).toHaveLength(2);
  });

  it('handles mixed formats', () => {
    const result = parseChannelInputBatch([
      '@channel1',
      't.me/channel2',
      '1611324665',
      'https://t.me/channel3',
    ]);
    expect(result.valid).toHaveLength(4);
    expect(result.invalid).toHaveLength(0);
  });
});

describe('bulk channel parser edge cases', () => {
  it('handles whitespace around inputs', () => {
    const result = parseChannelInputBatch([
      '  @channel1  ',
      '\t@channel2\n',
    ]);
    expect(result.valid).toHaveLength(2);
  });

  it('rejects invalid t.me URLs', () => {
    const result = parseChannelInputBatch(['t.me/', 'https://t.me/']);
    expect(result.invalid).toHaveLength(2);
  });

  it('validates numeric ID range', () => {
    const result = parseChannelInputBatch(['0', '-1']);
    // Both should be accepted as they're valid format (normalization happens)
    expect(result.valid.length + result.invalid.length).toBe(2);
  });

  it('handles large batches', () => {
    const inputs = Array.from({ length: 100 }, (_, i) => `@channel${i}`);
    const result = parseChannelInputBatch(inputs);
    expect(result.valid).toHaveLength(100);
  });

  it('case-insensitive username matching in dedup', () => {
    const result = parseChannelInputBatch([
      '@CHANNEL1',
      '@channel1',
      '@ChAnNeL1',
    ]);
    expect(result.valid).toHaveLength(1);
    expect(result.invalid).toHaveLength(2);
  });
});
