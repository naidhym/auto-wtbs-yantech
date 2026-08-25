import { describe, it, expect } from 'vitest';
import { canonicalTelegramChannelId, channelIdsMatch } from '../../src/user-client/telegram-channel-id.js';

describe('canonicalTelegramChannelId', () => {
  it('converts positive number to string', () => {
    expect(canonicalTelegramChannelId(3980589729)).toBe('3980589729');
  });

  it('converts negative number to positive string', () => {
    expect(canonicalTelegramChannelId(-1611324665)).toBe('1611324665');
  });

  it('handles positive string unchanged', () => {
    expect(canonicalTelegramChannelId('3980589729')).toBe('3980589729');
  });

  it('removes leading dash from negative string', () => {
    expect(canonicalTelegramChannelId('-1611324665')).toBe('1611324665');
  });

  it('handles BigInt positive', () => {
    const id = BigInt('3980589729');
    expect(canonicalTelegramChannelId(id)).toBe('3980589729');
  });

  it('handles BigInt negative and normalizes to positive', () => {
    const id = BigInt('-1611324665');
    expect(canonicalTelegramChannelId(id)).toBe('1611324665');
  });

  it('handles object with toString method', () => {
    const obj = {
      toString: () => '3980589729',
    };
    expect(canonicalTelegramChannelId(obj)).toBe('3980589729');
  });

  it('handles object with negative toString result', () => {
    const obj = {
      toString: () => '-1611324665',
    };
    expect(canonicalTelegramChannelId(obj)).toBe('1611324665');
  });

  it('throws on invalid input type', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
    expect(() => canonicalTelegramChannelId(null as any)).toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
    expect(() => canonicalTelegramChannelId(undefined as any)).toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
    expect(() => canonicalTelegramChannelId([] as any)).toThrow();
  });
});

describe('channelIdsMatch', () => {
  it('matches identical positive IDs', () => {
    expect(channelIdsMatch(3980589729, 3980589729)).toBe(true);
    expect(channelIdsMatch('3980589729', '3980589729')).toBe(true);
  });

  it('matches positive and negative representations of same channel', () => {
    expect(channelIdsMatch(1611324665, -1611324665)).toBe(true);
    expect(channelIdsMatch('1611324665', '-1611324665')).toBe(true);
    expect(channelIdsMatch('-1611324665', '1611324665')).toBe(true);
  });

  it('matches BigInt positive and string positive', () => {
    expect(channelIdsMatch(BigInt('3980589729'), '3980589729')).toBe(true);
  });

  it('matches BigInt negative and number positive', () => {
    expect(channelIdsMatch(BigInt('-1611324665'), 1611324665)).toBe(true);
  });

  it('does not match different channels', () => {
    expect(channelIdsMatch(3980589729, 1611324665)).toBe(false);
    expect(channelIdsMatch('3980589729', '1611324665')).toBe(false);
  });

  it('regression: tes channel ID normalization', () => {
    // tes is always positive: 3980589729
    expect(channelIdsMatch(3980589729, '3980589729')).toBe(true);
    expect(channelIdsMatch(BigInt('3980589729'), 3980589729)).toBe(true);
  });

  it('regression: old broken channel ID normalization', () => {
    // BASE WIB might have been stored negative but arrives positive in native updates
    expect(channelIdsMatch(-1611324665, '1611324665')).toBe(true);
    expect(channelIdsMatch(BigInt('-1611324665'), BigInt('1611324665'))).toBe(true);
  });

  it('regression: registry lookup with mixed representations', () => {
    // Simulates subscribe() registry key vs handleRawUpdate() lookup key
    const registryKey = canonicalTelegramChannelId(-1611324665);
    const lookupKey = canonicalTelegramChannelId(1611324665);
    expect(registryKey).toBe(lookupKey);
    expect(registryKey).toBe('1611324665');
  });
});
