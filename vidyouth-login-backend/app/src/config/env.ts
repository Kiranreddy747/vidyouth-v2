/**
 * Strongly-typed environment loader. Validates every variable at boot via
 * Zod and crashes loudly with a useful error if anything is missing or
 * malformed — better than discovering it from a stack trace at request time.
 */

import 'dotenv/config';
import { z } from 'zod';

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

  // SMS / email
  SMS_PROVIDER: z.enum(['mock', 'msg91', 'sns']).default('mock'),
  SMS_API_KEY: optionalEnv,
  // MSG91 (real SMS delivery for +91 and international numbers)
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
  // Tokens are appended in the URL fragment; the frontend reads + stores them.
  OAUTH_SUCCESS_REDIRECT_URL: z.string().url().default('http://localhost:5500/newhome.html'),

  // Email verification + password reset (added by PR #2)
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  EMAIL_VERIFICATION_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
  PASSWORD_RESET_TTL_SECONDS: z.coerce.number().int().positive().default(3_600),

  // AWS SDK config consumed by SES + SNS providers (PR #2)
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
  const needsAwsCredentials = value.EMAIL_PROVIDER === 'ses' || value.SMS_PROVIDER === 'sns';
  if (needsAwsCredentials && !value.AWS_ACCESS_KEY_ID) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AWS_ACCESS_KEY_ID'],
      message: 'Required when EMAIL_PROVIDER=ses or SMS_PROVIDER=sns',
    });
  }
  if (needsAwsCredentials && !value.AWS_SECRET_ACCESS_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AWS_SECRET_ACCESS_KEY'],
      message: 'Required when EMAIL_PROVIDER=ses or SMS_PROVIDER=sns',
    });
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
