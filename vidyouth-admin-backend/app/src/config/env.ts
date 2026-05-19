/**
 * Admin service environment loader. Validated at boot via Zod.
 *
 * This is a standalone service. It shares the platform Postgres + Redis
 * with the login API and verifies the same access tokens the login API
 * issues, so it needs the shared JWT public key.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotEnv } from 'dotenv';
import { z } from 'zod';

const configDir = dirname(fileURLToPath(import.meta.url));
const envPaths = [
  resolve(configDir, '../../.env'),
  resolve(configDir, '../../../.env'),
  resolve(configDir, '../../../../vidyouth-login-backend/.env'),
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), '../.env'),
  resolve(process.cwd(), '../../vidyouth-login-backend/.env'),
];

for (const path of [...new Set(envPaths)]) {
  if (existsSync(path)) {
    loadDotEnv({ path });
  }
}

if (!process.env.DATABASE_URL && process.env.POSTGRES_DB && process.env.POSTGRES_USER) {
  const host = process.env.POSTGRES_HOST || '127.0.0.1';
  const port = process.env.POSTGRES_PORT || '5432';
  const password = process.env.POSTGRES_PASSWORD || '';
  process.env.DATABASE_URL =
    `postgres://${encodeURIComponent(process.env.POSTGRES_USER)}` +
    `:${encodeURIComponent(password)}@${host}:${port}/${process.env.POSTGRES_DB}`;
}

if (!process.env.REDIS_URL && process.env.REDIS_PORT) {
  const host = process.env.REDIS_HOST || '127.0.0.1';
  process.env.REDIS_URL = `redis://${host}:${process.env.REDIS_PORT}`;
}

const optionalEnv = z.preprocess(
  (value) => value === '' ? undefined : value,
  z.string().optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(8090),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),
  PG_POOL_IDLE_MS: z.coerce.number().int().nonnegative().default(10_000),

  REDIS_URL: z.string().url(),
  REDIS_KEY_PREFIX: z.string().default('vidyouth:dev:'),

  JWT_PUBLIC_KEY: optionalEnv,
  JWT_ISSUER: z.string().default('vidyouth.auth'),
  JWT_AUDIENCE: z.string().default('vidyouth.lms'),

  // Used by admin-initiated password reset (M2) to build the reset link
  // the login API consumes. Mirrors the login service defaults.
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  PASSWORD_RESET_TTL_SECONDS: z.coerce.number().int().positive().default(3_600),
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Admin service environment validation failed:');
  for (const issue of parsed.error.issues) {
    // eslint-disable-next-line no-console
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env: Env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
