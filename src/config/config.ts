import path from 'node:path';

import dotenv from 'dotenv';
import { z } from 'zod';

const emptyStringToUndefined = (value: unknown): unknown =>
  value === '' ? undefined : value;

const optionalString = z.preprocess(
  emptyStringToUndefined,
  z.string().trim().min(1).optional(),
);

const optionalPositiveInteger = z.preprocess(
  emptyStringToUndefined,
  z.coerce.number().int().positive().optional(),
);

const booleanFromEnvironment = z.preprocess((value) => {
  if (value === undefined || value === '') {
    return false;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();

    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }

    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }

  return value;
}, z.boolean());

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    DATABASE_PATH: z.string().trim().min(1).default('./data/auto-wtb.sqlite'),
    SESSION_DIRECTORY: z.string().trim().min(1).default('./data/sessions'),
    LOG_DIRECTORY: z.string().trim().min(1).default('./logs'),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
    LOGIN_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(30_000)
      .max(900_000)
      .default(300_000),
    ADMIN_BOT_ENABLED: booleanFromEnvironment,
    ADMIN_BOT_TOKEN: optionalString,
    OWNER_TELEGRAM_ID: z.preprocess(
      emptyStringToUndefined,
      z.string().trim().regex(/^\d+$/, 'must be a numeric Telegram user ID').optional(),
    ),
    TELEGRAM_API_ID: optionalPositiveInteger,
    TELEGRAM_API_HASH: optionalString,
  })
  .superRefine((environment, context) => {
    if (environment.ADMIN_BOT_ENABLED && environment.ADMIN_BOT_TOKEN === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['ADMIN_BOT_TOKEN'],
        message: 'is required when ADMIN_BOT_ENABLED=true',
      });
    }

    if (environment.ADMIN_BOT_ENABLED && environment.OWNER_TELEGRAM_ID === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['OWNER_TELEGRAM_ID'],
        message: 'is required when ADMIN_BOT_ENABLED=true',
      });
    }

    const hasApiId = environment.TELEGRAM_API_ID !== undefined;
    const hasApiHash = environment.TELEGRAM_API_HASH !== undefined;

    if (hasApiId !== hasApiHash) {
      context.addIssue({
        code: 'custom',
        path: hasApiId ? ['TELEGRAM_API_HASH'] : ['TELEGRAM_API_ID'],
        message: 'TELEGRAM_API_ID and TELEGRAM_API_HASH must be provided together',
      });
    }
  });

export interface AppConfig {
  readonly environment: 'development' | 'test' | 'production';
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly shutdownTimeoutMs: number;
  readonly loginTimeoutMs: number;
  readonly storage: {
    readonly databasePath: string;
    readonly sessionDirectory: string;
    readonly logDirectory: string;
  };
  readonly adminBot: {
    readonly enabled: boolean;
    readonly token?: string;
    readonly ownerTelegramId?: string;
  };
  readonly telegram: {
    readonly apiId?: number;
    readonly apiHash?: string;
  };
}

export interface LoadConfigOptions {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly envFilePath?: string;
  readonly loadDotenv?: boolean;
}

export class ConfigValidationError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly z.core.$ZodIssue[]) {
    const messages = issues.map((issue) => {
      const key = issue.path.join('.') || 'environment';
      return `${key}: ${issue.message}`;
    });

    super(`Invalid Auto WTB Bot configuration:\n${messages.join('\n')}`);
    this.name = 'ConfigValidationError';
    this.issues = messages;
  }
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const environment: NodeJS.ProcessEnv = {
    ...(options.environment ?? process.env),
  };

  if (options.loadDotenv ?? true) {
    dotenv.config({
      path: options.envFilePath ?? path.join(cwd, '.env'),
      processEnv: environment,
      quiet: true,
    });
  }

  const parsed = environmentSchema.safeParse(environment);

  if (!parsed.success) {
    throw new ConfigValidationError(parsed.error.issues);
  }

  const config: AppConfig = {
    environment: parsed.data.NODE_ENV,
    logLevel: parsed.data.LOG_LEVEL,
    shutdownTimeoutMs: parsed.data.SHUTDOWN_TIMEOUT_MS,
    loginTimeoutMs: parsed.data.LOGIN_TIMEOUT_MS,
    storage: {
      databasePath: path.resolve(cwd, parsed.data.DATABASE_PATH),
      sessionDirectory: path.resolve(cwd, parsed.data.SESSION_DIRECTORY),
      logDirectory: path.resolve(cwd, parsed.data.LOG_DIRECTORY),
    },
    adminBot: {
      enabled: parsed.data.ADMIN_BOT_ENABLED,
      ...(parsed.data.ADMIN_BOT_TOKEN === undefined
        ? {}
        : { token: parsed.data.ADMIN_BOT_TOKEN }),
      ...(parsed.data.OWNER_TELEGRAM_ID === undefined
        ? {}
        : { ownerTelegramId: parsed.data.OWNER_TELEGRAM_ID }),
    },
    telegram: {
      ...(parsed.data.TELEGRAM_API_ID === undefined
        ? {}
        : { apiId: parsed.data.TELEGRAM_API_ID }),
      ...(parsed.data.TELEGRAM_API_HASH === undefined
        ? {}
        : { apiHash: parsed.data.TELEGRAM_API_HASH }),
    },
  };

  validateStorageIsolation(config);
  return config;
}

function validateStorageIsolation(config: AppConfig): void {
  if (config.storage.sessionDirectory === config.storage.logDirectory) {
    throw new ConfigValidationError([
      {
        code: 'custom',
        input: config.storage.sessionDirectory,
        path: ['SESSION_DIRECTORY', 'LOG_DIRECTORY'],
        message: 'must resolve to different directories',
      },
    ]);
  }
}
