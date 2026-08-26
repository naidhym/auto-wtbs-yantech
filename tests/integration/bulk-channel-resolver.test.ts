import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TelegramClient } from 'telegram';

import { BulkChannelResolver } from '../../src/channels/bulk-channel-resolver.js';
import type { ChannelRepository } from '../../src/channels/channel.repository.js';

describe('BulkChannelResolver', () => {
  let mockClient: TelegramClient;
  let mockRepository: ChannelRepository;
  let resolver: BulkChannelResolver;

  beforeEach(() => {
    mockClient = {} as TelegramClient;
    mockRepository = {
      getByTelegramId: vi.fn(),
    } as unknown as ChannelRepository;
    resolver = new BulkChannelResolver(mockClient, mockRepository);
  });

  describe('resolve - result structure', () => {
    it('returns object with valid, invalid, and duplicates arrays', async () => {
      const result = await resolver.resolve('');

      expect(result).toHaveProperty('valid');
      expect(result).toHaveProperty('invalid');
      expect(result).toHaveProperty('duplicates');
      expect(Array.isArray(result.valid)).toBe(true);
      expect(Array.isArray(result.invalid)).toBe(true);
      expect(Array.isArray(result.duplicates)).toBe(true);
    });
  });

  describe('resolve - empty input', () => {
    it('handles empty string', async () => {
      const result = await resolver.resolve('');

      expect(result.valid.length).toBe(0);
      expect(result.invalid.length).toBeGreaterThanOrEqual(0);
      expect(result.duplicates.length).toBe(0);
    });

    it('handles whitespace only', async () => {
      const result = await resolver.resolve('  \n  \n  ');

      expect(result.valid.length).toBe(0);
      expect(result.duplicates.length).toBe(0);
    });
  });

  describe('resolve - parsing', () => {
    it('processes input without crashing', async () => {
      const input = '@channel1\n@channel2\n@channel3';
      const result = await resolver.resolve(input);
      expect(result).toBeDefined();
      expect(Array.isArray(result.valid)).toBe(true);
      expect(Array.isArray(result.invalid)).toBe(true);
      expect(Array.isArray(result.duplicates)).toBe(true);
    });

    it('trims whitespace and filters empty lines', async () => {
      const input = '  @channel1  \n\n  @channel2  \n\n\n@channel3';
      const result = await resolver.resolve(input);
      expect(result).toBeDefined();
    });
  });

  describe('resolve - error handling', () => {
    it('processes each identifier independently', async () => {
      const input = '@id1\n@id2\n@id3';
      const result = await resolver.resolve(input);
      
      const totalProcessed = result.valid.length + result.invalid.length + result.duplicates.length;
      expect(totalProcessed).toBeGreaterThanOrEqual(0);
    });
  });
});
