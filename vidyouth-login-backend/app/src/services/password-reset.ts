/**
 * Password reset orchestration.
 *
 * Uses the same lifecycle as email verification: raw token generated once,
 * SHA-256 hash persisted, generic request response, atomic consume on reset.
 */

import type { FastifyBaseLogger } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import {
  consumeResetToken,
  createResetToken,
  revokeUserResetTokens,
} from '../repositories/password-reset.js';
import {
  findActiveUserByEmail,
  findUserByPhone,
  updateUserPassword,
} from '../repositories/users.js';
import { recordAudit } from '../services/audit.js';
import { getEmailProvider } from '../services/email/index.js';
import { issueOtp, verifyOtp } from '../services/otp.js';
import { hashPassword, validatePasswordStrength } from '../services/passwords.js';
import { normalizePhoneNumber } from '../services/phone-auth.js';
import { endAllSessions } from '../services/sessions.js';
import { getSmsProvider } from '../services/sms/index.js';

export interface RequestPasswordResetInput {
  email: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
  logger: FastifyBaseLogger;
}

export interface ResetPasswordInput {
  token: string;
  newPassword: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface RequestPhonePasswordResetInput {
  phoneNumber: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
  logger: FastifyBaseLogger;
}

export interface ResetPasswordWithPhoneOtpInput {
  phoneNumber: string;
  code: string;
  newPassword: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export class InvalidPasswordResetTokenError extends Error {
  constructor() {
    super('invalid_password_reset_token');
    this.name = 'InvalidPasswordResetTokenError';
  }
}

export class WeakPasswordResetPasswordError extends Error {
  issues: string[];

  constructor(issues: string[]) {
    super('weak_password');
    this.name = 'WeakPasswordResetPasswordError';
    this.issues = issues;
  }
}

export class InvalidPhonePasswordResetOtpError extends Error {
  constructor() {
    super('invalid_phone_password_reset_otp');
    this.name = 'InvalidPhonePasswordResetOtpError';
  }
}

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function createRawResetToken(): string {
  return randomBytes(32).toString('base64url');
}

function getResetExpiry(): Date {
  return new Date(Date.now() + env.PASSWORD_RESET_TTL_SECONDS * 1000);
}

function buildResetUrl(token: string): string {
  const baseUrl = env.APP_BASE_URL.replace(/\/+$/, '');
  return `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
}

export async function requestPasswordReset(
  input: RequestPasswordResetInput,
): Promise<void> {
  const user = await findActiveUserByEmail(input.email);

  // Generic behavior prevents email/account enumeration.
  if (!user || !user.email || !user.password_hash || !user.is_active) {
    await recordAudit({
      userId: user?.id,
      action: 'password.reset.requested',
      ip: input.ip,
      userAgent: input.userAgent,
      meta: { delivered: false },
      succeeded: true,
    });
    return;
  }

  // TODO(password-reset-rate-limit): add per-email and per-IP Redis throttles.
  await revokeUserResetTokens(user.id);

  const rawToken = createRawResetToken();
  const tokenHash = hashResetToken(rawToken);
  const expiresAt = getResetExpiry();

  await createResetToken({
    userId: user.id,
    tokenHash,
    expiresAt,
    requestedIp: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });

  await getEmailProvider().sendPasswordResetEmail({
    to: user.email,
    resetUrl: buildResetUrl(rawToken),
    expiresAt,
    logger: input.logger,
  });

  await recordAudit({
    userId: user.id,
    action: 'password.reset.requested',
    ip: input.ip,
    userAgent: input.userAgent,
    meta: { delivered: true },
    succeeded: true,
  });
}

export async function resetPassword(input: ResetPasswordInput): Promise<void> {
  const strength = validatePasswordStrength(input.newPassword);
  if (!strength.valid) {
    await recordAudit({
      action: 'password.reset.failed',
      ip: input.ip,
      userAgent: input.userAgent,
      meta: { reason: 'weak_password', issues: strength.issues },
      succeeded: false,
    });
    throw new WeakPasswordResetPasswordError(strength.issues);
  }

  const tokenHash = hashResetToken(input.token);
  const consumed = await consumeResetToken(tokenHash);

  if (!consumed) {
    await recordAudit({
      action: 'password.reset.failed',
      ip: input.ip,
      userAgent: input.userAgent,
      meta: { reason: 'invalid_or_expired' },
      succeeded: false,
    });
    throw new InvalidPasswordResetTokenError();
  }

  const passwordHash = await hashPassword(input.newPassword);
  const user = await updateUserPassword(consumed.user_id, passwordHash);

  if (!user) {
    await recordAudit({
      userId: consumed.user_id,
      action: 'password.reset.failed',
      ip: input.ip,
      userAgent: input.userAgent,
      meta: { reason: 'user_not_found' },
      succeeded: false,
    });
    throw new InvalidPasswordResetTokenError();
  }

  await revokeUserResetTokens(user.id);
  await endAllSessions(user.id, 'password_reset');

  await recordAudit({
    userId: user.id,
    action: 'password.reset.completed',
    ip: input.ip,
    userAgent: input.userAgent,
    succeeded: true,
  });

  // TODO(password-reset-session): optionally call createAuthenticatedSession()
  // after reset when the product wants immediate login from the reset screen.
  // TODO(password-history): reject recently used passwords before update.
  // TODO(suspicious-activity): flag resets from unusual IP/device patterns.
  // TODO(MFA-reset): require MFA/passkey recovery for privileged accounts.
}

export async function requestPhonePasswordReset(
  input: RequestPhonePasswordResetInput,
): Promise<void> {
  const phoneNumber = normalizePhoneNumber(input.phoneNumber);
  const user = await findUserByPhone(phoneNumber);

  // Generic audit/response behavior prevents phone-number enumeration.
  if (!user || !user.is_active) {
    await recordAudit({
      userId: user?.id,
      action: 'password.reset.requested',
      ip: input.ip,
      userAgent: input.userAgent,
      meta: { channel: 'sms', delivered: false },
      succeeded: true,
    });
    return;
  }

  const otp = await issueOtp('sms', phoneNumber);
  await getSmsProvider().sendOtp({
    to: phoneNumber,
    code: otp.code,
    expiresInSec: otp.expiresInSec,
    logger: input.logger,
  });

  await recordAudit({
    userId: user.id,
    action: 'password.reset.requested',
    ip: input.ip,
    userAgent: input.userAgent,
    meta: { channel: 'sms', delivered: true },
    succeeded: true,
  });
}

export async function resetPasswordWithPhoneOtp(
  input: ResetPasswordWithPhoneOtpInput,
): Promise<void> {
  const phoneNumber = normalizePhoneNumber(input.phoneNumber);
  const strength = validatePasswordStrength(input.newPassword);
  if (!strength.valid) {
    await recordAudit({
      action: 'password.reset.failed',
      ip: input.ip,
      userAgent: input.userAgent,
      meta: { channel: 'sms', reason: 'weak_password', issues: strength.issues },
      succeeded: false,
    });
    throw new WeakPasswordResetPasswordError(strength.issues);
  }

  const ok = await verifyOtp('sms', phoneNumber, input.code);
  if (!ok) {
    await recordAudit({
      action: 'password.reset.failed',
      ip: input.ip,
      userAgent: input.userAgent,
      meta: { channel: 'sms', reason: 'invalid_otp' },
      succeeded: false,
    });
    throw new InvalidPhonePasswordResetOtpError();
  }

  const user = await findUserByPhone(phoneNumber);
  if (!user || !user.is_active) {
    await recordAudit({
      userId: user?.id,
      action: 'password.reset.failed',
      ip: input.ip,
      userAgent: input.userAgent,
      meta: { channel: 'sms', reason: 'user_not_found_or_inactive' },
      succeeded: false,
    });
    throw new InvalidPhonePasswordResetOtpError();
  }

  const passwordHash = await hashPassword(input.newPassword);
  const updated = await updateUserPassword(user.id, passwordHash);
  if (!updated) {
    throw new InvalidPhonePasswordResetOtpError();
  }

  await endAllSessions(user.id, 'password_reset');

  await recordAudit({
    userId: user.id,
    action: 'password.reset.completed',
    ip: input.ip,
    userAgent: input.userAgent,
    meta: { channel: 'sms' },
    succeeded: true,
  });
}

// TODO(password-reset-email-templates): add branded HTML and plain-text mail.
// TODO(password-reset-email-queue): enqueue provider sends with retry/backoff.
// TODO(SES): plug SesEmailProvider in without changing this service.
// TODO(password-reset-rate-limit): add Redis throttles for phone reset attempts.
