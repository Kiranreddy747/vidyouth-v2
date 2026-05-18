/**
 * Admin service environment loader. Validated at boot via Zod.
 *
 * This is a STANDALONE service. It shares the platform Postgres + Redis
 * with the login API (to read users / sessions / audit and own
 * feature_flags) and verifies the SAME access tokens the login API
 * issues — so it only needs the JWT *public* key, never the private one.
 */

import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  // Own port — runs alongside the login API (8080).
  PORT: z.coerce.number().int().positive().default(8090),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Shared platform Postgres (login API owns users/sessions; this service
  // owns feature_flags and reads the rest).
  DATABASE_URL: z.string().url(),
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),
  PG_POOL_IDLE_MS: z.coerce.number().int().nonnegative().default(10_000),

  // Shared platform Redis (session-active / force-logout check).
  REDIS_URL: z.string().url(),
  REDIS_KEY_PREFIX: z.string().default('vidyouth:dev:'),

  // JWT — verify only. Must match the login API's issuer/audience and
  // its RS256 key pair (public half only here).
  JWT_PUBLIC_KEY: z.string().optional(),
  JWT_ISSUER: z.string().default('vidyouth.auth'),
  JWT_AUDIENCE: z.string().default('vidyouth.lms'),
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
