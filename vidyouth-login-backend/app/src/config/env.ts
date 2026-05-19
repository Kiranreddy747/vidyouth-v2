/**
 * Strongly-typed environment loader. Validates every variable at boot via
 * Zod and crashes loudly with a useful error if anything is missing or
 * malformed.
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
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), '../.env'),
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

const optionalUrlEnv = z.preprocess(
  (value) => value === '' ? undefined : value,
  z.string().url().optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Postgres
  DATABASE_URL: z.string().url(),
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),
  PG_POOL_IDLE_MS: z.coerce.number().int().nonnegative().default(10_000),

  // Redis
  REDIS_URL: z.string().url(),
  REDIS_KEY_PREFIX: z.string().default('vidyouth:dev:'),

  // JWT
  JWT_PRIVATE_KEY: optionalEnv,
  JWT_PUBLIC_KEY: optionalEnv,
  JWT_ISSUER: z.string().default('vidyouth.auth'),
  JWT_AUDIENCE: z.string().default('vidyouth.lms'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),

  // Passwords
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),
  BCRYPT_PEPPER: z.string().min(16).default('dev-pepper-replace-in-prod'),

  // Lockout
  LOCKOUT_MAX_FAILED: z.coerce.number().int().positive().default(5),
  LOCKOUT_WINDOW_SECONDS: z.coerce.number().int().positive().default(1_800),
  LOCKOUT_DURATION_SECONDS: z.coerce.number().int().positive().default(1_800),

  // Sessions
  SESSION_MAX_PER_USER: z.coerce.number().int().positive().default(3),

  // OTP
  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  OTP_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(600),
  OTP_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  OAUTH_MFA_ENABLED: z.coerce.boolean().default(true),
  OAUTH_MFA_TTL_SECONDS: z.coerce.number().int().positive().default(600),

  // SMS / email
  SMS_PROVIDER: z.enum(['mock', 'msg91', 'sns']).default('mock'),
  SMS_API_KEY: optionalEnv,
  MSG91_AUTH_KEY: optionalEnv,
  MSG91_TEMPLATE_ID: optionalEnv,
  MSG91_SENDER_ID: optionalEnv,
  EMAIL_PROVIDER: z.enum(['mock', 'ses']).default('mock'),
  EMAIL_FROM: z.string().email().default('no-reply@vidyouth.local'),

  // Audit
  AUDIT_S3_BUCKET: optionalEnv,
  AUDIT_S3_REGION: z.string().default('ap-south-1'),

  // Google OAuth
  GOOGLE_CLIENT_ID: optionalEnv,
  GOOGLE_CLIENT_SECRET: optionalEnv,
  GOOGLE_REDIRECT_URI: optionalUrlEnv,

  // Microsoft OAuth
  MICROSOFT_CLIENT_ID: optionalEnv,
  MICROSOFT_CLIENT_SECRET: optionalEnv,
  MICROSOFT_TENANT_ID: z.string().default('common'),
  MICROSOFT_REDIRECT_URI: optionalUrlEnv,

  // Where the OAuth callback sends the browser after a successful login.
  OAUTH_SUCCESS_REDIRECT_URL: z.string().url().default('http://localhost:5500/newhome.html'),

  // Email verification + password reset
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  EMAIL_VERIFICATION_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
  PASSWORD_RESET_TTL_SECONDS: z.coerce.number().int().positive().default(3_600),

  // AWS SDK config consumed by SES + SNS providers
  AWS_REGION: z.string().default('ap-south-1'),
  AWS_SMS_REGION: optionalEnv,
  AWS_EMAIL_REGION: optionalEnv,
  AWS_ACCESS_KEY_ID: optionalEnv,
  AWS_SECRET_ACCESS_KEY: optionalEnv,
  AWS_SESSION_TOKEN: optionalEnv,
  SES_FROM_EMAIL: z.string().email().default('no-reply@vidyouth.local'),
  SNS_SMS_TYPE: z.enum(['Transactional', 'Promotional']).default('Transactional'),
  SNS_SENDER_ID: optionalEnv,
  SNS_ENTITY_ID: optionalEnv,
  SNS_TEMPLATE_ID: optionalEnv,
}).superRefine((value, ctx) => {
  if (value.NODE_ENV === 'test') return;

  // Static AWS keys are only mandated outside production. In production the
  // service runs on an EC2 IAM instance role, so the AWS SDK resolves
  // credentials from the default provider chain (instance metadata) and no
  // AWS_ACCESS_KEY_ID/SECRET should be injected — shipping static keys to a
  // fleet is exactly the footgun we're avoiding here.
  if (value.NODE_ENV !== 'production') {
    const needsAwsCredentials = value.EMAIL_PROVIDER === 'ses' || value.SMS_PROVIDER === 'sns';
    if (needsAwsCredentials && !value.AWS_ACCESS_KEY_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AWS_ACCESS_KEY_ID'],
        message: 'Required when EMAIL_PROVIDER=ses or SMS_PROVIDER=sns (non-production)',
      });
    }
    if (needsAwsCredentials && !value.AWS_SECRET_ACCESS_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AWS_SECRET_ACCESS_KEY'],
        message: 'Required when EMAIL_PROVIDER=ses or SMS_PROVIDER=sns (non-production)',
      });
    }
  }
  if (value.SMS_PROVIDER === 'msg91' && !value.MSG91_AUTH_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MSG91_AUTH_KEY'],
      message: 'Required when SMS_PROVIDER=msg91',
    });
  }
  if (value.SMS_PROVIDER === 'msg91' && !value.MSG91_TEMPLATE_ID) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MSG91_TEMPLATE_ID'],
      message: 'Required when SMS_PROVIDER=msg91',
    });
  }
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Environment validation failed:');
  for (const issue of parsed.error.issues) {
    // eslint-disable-next-line no-console
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env: Env = parsed.data;

export const isProd = env.NODE_ENV === 'production';
