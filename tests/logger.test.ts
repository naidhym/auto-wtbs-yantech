import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createLogger, logEvent } from '../src/logging/logger.js';

describe('centralized logger', () => {
  it('writes structured event fields and an ISO timestamp', () => {
    const logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-wtb-log-'));
    const loggerHandle = createLogger({
      level: 'debug',
      logDirectory,
      environment: 'test',
      writeToStdout: false,
    });

    logEvent(
      loggerHandle.logger,
      'info',
      {
        account: 'account-1',
        channel: 'channel-1',
        rule: 'rule-1',
        action: 'detected',
        status: 'valid',
        errorReason: 'none',
      },
      'Structured log test',
    );
    loggerHandle.close();

    const entry = JSON.parse(
      fs.readFileSync(loggerHandle.logFilePath, 'utf8').trim(),
    ) as Record<string, unknown>;

    expect(entry).toMatchObject({
      service: 'auto-wtb-bot',
      environment: 'test',
      account: 'account-1',
      channel: 'channel-1',
      rule: 'rule-1',
      action: 'detected',
      status: 'valid',
      errorReason: 'none',
    });
    expect(new Date(String(entry.time)).toISOString()).toBe(entry.time);
  });

  it('redacts M2 authentication and session fields', () => {
    const logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-wtb-redact-'));
    const loggerHandle = createLogger({
      level: 'debug',
      logDirectory,
      environment: 'test',
      writeToStdout: false,
    });

    loggerHandle.logger.info(
      {
        otp: '654321',
        password: 'two-factor-secret',
        apiHash: 'api-hash-secret',
        session: 'session-secret',
      },
      'Redaction test',
    );
    loggerHandle.close();

    const output = fs.readFileSync(loggerHandle.logFilePath, 'utf8');
    expect(output).not.toContain('654321');
    expect(output).not.toContain('two-factor-secret');
    expect(output).not.toContain('api-hash-secret');
    expect(output).not.toContain('session-secret');
    expect(output.match(/\[REDACTED\]/g)).toHaveLength(4);
  });
});
