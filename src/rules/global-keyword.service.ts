import type { DatabaseSync } from 'node:sqlite';

import type { AppLogger } from '../logging/logger.js';

const TRIGGER_KEY = 'global_trigger_keywords';
const EXCLUDE_KEY = 'global_exclude_keywords';
const CLEANUP_KEY = 'global_cleanup_patterns';
const ENABLED_KEY = 'global_detection_enabled';

export interface GlobalKeywordConfiguration {
  readonly triggerKeywords: readonly string[];
  readonly excludeKeywords: readonly string[];
  readonly cleanupPatterns: readonly string[];
  readonly enabled: boolean;
}

export class GlobalKeywordService {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly logger: AppLogger,
  ) {
    this.ensureDefaults();
  }

  public getConfiguration(): GlobalKeywordConfiguration {
    return {
      triggerKeywords: this.read(TRIGGER_KEY),
      excludeKeywords: this.read(EXCLUDE_KEY),
      cleanupPatterns: this.read(CLEANUP_KEY),
      enabled: this.readBoolean(ENABLED_KEY, true),
    };
  }

  public setTriggerKeywords(value: string): readonly string[] {
    const keywords = parseCommaSeparatedKeywords(value);
    this.write(TRIGGER_KEY, keywords, 'Global trigger keywords used by channel-only detection');
    this.logger.info(
      { action: 'global_trigger_keywords_updated', status: 'updated', keywordCount: keywords.length },
      'Global trigger keywords updated',
    );
    return keywords;
  }

  public setExcludeKeywords(value: string): readonly string[] {
    const keywords = parseCommaSeparatedKeywords(value);
    this.write(EXCLUDE_KEY, keywords, 'Global exclude keywords used by channel-only detection');
    this.logger.info(
      { action: 'global_exclude_keywords_updated', status: 'updated', keywordCount: keywords.length },
      'Global exclude keywords updated',
    );
    return keywords;
  }

  public setCleanupPatterns(value: string): readonly string[] {
    const patterns = parseCommaSeparatedKeywords(value);
    this.write(CLEANUP_KEY, patterns, 'Global sender display-name cleanup patterns');
    this.logger.info(
      { action: 'global_cleanup_patterns_updated', status: 'updated', patternCount: patterns.length },
      'Global cleanup patterns updated',
    );
    return patterns;
  }

  public setEnabled(enabled: boolean): GlobalKeywordConfiguration {
    this.writeRaw(
      ENABLED_KEY,
      JSON.stringify(enabled),
      'Enable global channel-only keyword detection',
    );
    this.logger.info(
      { action: enabled ? 'global_detection_enabled' : 'global_detection_disabled', status: enabled ? 'enabled' : 'disabled' },
      `Global detection ${enabled ? 'enabled' : 'disabled'}`,
    );
    return this.getConfiguration();
  }

  private ensureDefaults(): void {
    const statement = this.database.prepare(`
      INSERT INTO settings (key, value, description)
      VALUES (?, '[]', ?)
      ON CONFLICT(key) DO NOTHING
    `);
    statement.run(TRIGGER_KEY, 'Global trigger keywords used by channel-only detection');
    statement.run(EXCLUDE_KEY, 'Global exclude keywords used by channel-only detection');
    statement.run(CLEANUP_KEY, 'Global sender display-name cleanup patterns');
    this.database.prepare(`
      INSERT INTO settings (key, value, description)
      VALUES (?, 'true', ?)
      ON CONFLICT(key) DO NOTHING
    `).run(ENABLED_KEY, 'Enable global channel-only keyword detection');
  }

  private read(key: string): string[] {
    const row = this.database.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    if (row === undefined) return [];
    const parsed: unknown = JSON.parse(row.value);
    if (!Array.isArray(parsed)) throw new Error(`Invalid global keyword setting: ${key}`);
    const values: unknown[] = parsed;
    if (values.some((item) => typeof item !== 'string')) {
      throw new Error(`Invalid global keyword setting: ${key}`);
    }
    return values.map((item) => {
      if (typeof item !== 'string') throw new Error(`Invalid global keyword setting: ${key}`);
      return item;
    });
  }

  private write(key: string, keywords: readonly string[], description: string): void {
    this.writeRaw(key, JSON.stringify(keywords), description);
  }

  private readBoolean(key: string, fallback: boolean): boolean {
    const row = this.database.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    if (row === undefined) return fallback;
    const parsed: unknown = JSON.parse(row.value);
    if (typeof parsed !== 'boolean') throw new Error(`Invalid global setting: ${key}`);
    return parsed;
  }

  private writeRaw(key: string, value: string, description: string): void {
    this.database.prepare(`
      INSERT INTO settings (key, value, description)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        description = excluded.description,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `).run(key, value, description);
  }
}

export function parseCommaSeparatedKeywords(value: string): string[] {
  const normalized = value
    .split(',')
    .map((keyword) => keyword.trim().replace(/\s+/g, ' ').toLocaleLowerCase('id-ID'))
    .filter((keyword) => keyword.length > 0);
  if (normalized.some((keyword) => keyword.length > 100)) {
    throw new Error('Each keyword must not exceed 100 characters');
  }
  return [...new Set(normalized)];
}
