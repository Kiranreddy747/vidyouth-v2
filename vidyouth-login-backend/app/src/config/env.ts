/**
 * Strongly-typed environment loader. Validates every variable at boot via
 * Zod and crashes loudly with a useful error if anything is missing or
 * malformed — better than discovering it from a stack trace at request time.
 */

import 'dotenv/config';
import { z } from 'zod';

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
  JWT_PRIVATE_KEY: z.string().optional(),
  JWT_PUBLIC_KEY: z.string().optional(),
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

  // SMS / email
  SMS_PROVIDER: z.enum(['mock', 'msg91', 'sns']).default('mock'),
  SMS_API_KEY: z.string().optional(),
  // MSG91 (real SMS delivery for +91 and international numbers)
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_TEMPLATE_ID: z.string().optional(),
  MSG91_SENDER_ID: z.string().optional(),
  EMAIL_PROVIDER: z.enum(['mock', 'ses']).default('mock'),
  EMAIL_FROM: z.string().email().default('no-reply@vidyouth.local'),

  // Audit
  AUDIT_S3_BUCKET: z.string().optional(),
  AUDIT_S3_REGION: z.string().default('ap-south-1'),
  
  // Google OAuth
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),

  // Microsoft OAuth
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_TENANT_ID: z.string().default('common'),
  MICROSOFT_REDIRECT_URI: z.string().url().optional(),

  // Where the OAuth callback sends the browser after a successful login.
  // Tokens are appended in the URL fragment; the frontend reads + stores them.
  OAUTH_SUCCESS_REDIRECT_URL: z.string().url().default('http://localhost:5500/newhome.html'),

  // Email verification + password reset (added by PR #2)
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  EMAIL_VERIFICATION_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
  PASSWORD_RESET_TTL_SECONDS: z.coerce.number().int().positive().default(3_600),

  // AWS SDK config consumed by SES + SNS providers (PR #2)
  AWS_REGION: z.string().default('ap-south-1'),
  SES_FROM_EMAIL: z.string().email().default('no-reply@vidyouth.local'),
  SNS_SMS_TYPE: z.enum(['Transactional', 'Promotional']).default('Transactional'),
  SNS_SENDER_ID: z.string().optional(),
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
