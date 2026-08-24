import path from 'node:path';

import pino, { type DestinationStream, type Logger } from 'pino';

import type { AppConfig } from '../config/config.js';

export type AppLogger = Logger;
export type AppLogLevel = AppConfig['logLevel'];

export interface LogEvent {
  readonly account?: string | number;
  readonly channel?: string | number;
  readonly action: string;
  readonly status: string;
  readonly errorReason?: string;
  readonly rule?: string | number;
  readonly [key: string]: unknown;
}

export interface LoggerHandle {
  readonly logger: AppLogger;
  readonly logFilePath: string;
  close(): void;
}

export interface CreateLoggerOptions {
  readonly level: AppLogLevel;
  readonly logDirectory: string;
  readonly environment: AppConfig['environment'];
  readonly writeToStdout?: boolean;
}

export function createLogger(options: CreateLoggerOptions): LoggerHandle {
  const logFilePath = path.join(options.logDirectory, 'application.log');
  const fileDestination = pino.destination({
    dest: logFilePath,
    mkdir: true,
    sync: true,
  });
  const streams: Array<{ level: AppLogLevel; stream: DestinationStream }> = [
    { level: options.level, stream: fileDestination },
  ];

  if (options.writeToStdout ?? true) {
    streams.unshift({ level: options.level, stream: process.stdout });
  }

  const logger = pino(
    {
      level: options.level,
      base: {
        service: 'auto-wtb-bot',
        environment: options.environment,
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: [
          'ADMIN_BOT_TOKEN',
          'TELEGRAM_API_HASH',
          'token',
          '*.token',
          'apiHash',
          '*.apiHash',
          'session',
          '*.session',
          'sessionString',
          '*.sessionString',
          'otp',
          '*.otp',
          'phoneCode',
          '*.phoneCode',
          'password',
          '*.password',
        ],
        censor: '[REDACTED]',
      },
    },
    pino.multistream(streams),
  );

  return {
    logger,
    logFilePath,
    close(): void {
      logger.flush();
      fileDestination.flushSync();
      fileDestination.end();
    },
  };
}

export function logEvent(
  logger: AppLogger,
  level: AppLogLevel,
  event: LogEvent,
  message: string,
): void {
  logger[level](event, message);
}

export function errorReason(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === 'string' ? error : 'Unknown error';
}
