/**
 * OAuth MFA challenges.
 *
 * Google/Microsoft prove ownership of the provider account. This service adds
 * a second local factor before the API mints Vidyouth access/refresh tokens.
 */

import type { FastifyBaseLogger } from 'fastify';
import { randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { redis } from '../db/redis.js';
import type { IdentityProvider } from '../repositories/user-identities.js';
import type { UserRecord } from '../repositories/users.js';
import { getEmailProvider } from './email/index.js';
import { issueOtp, verifyOtp } from './otp.js';

export interface OauthMfaChallenge {
  token: string;
  userId: string;
  provider: IdentityProvider;
  providerSubject: string;
  email: string;
  expiresInSec: number;
}

const challengeKey = (token: string) => `oauthmfa:${token}`;
const otpIdentifier = (token: string) => `oauthmfa:${token}`;

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  if (!domain) return email;
  const visible = local.length <= 2 ? local[0] ?? '' : `${local[0]}${local.at(-1)}`;
  return `${visible}${'*'.repeat(Math.max(2, local.length - visible.length))}@${domain}`;
}

export function maskedMfaEmail(email: string): string {
  return maskEmail(email);
}

export async function createOauthMfaChallenge(input: {
  user: UserRecord;
  provider: IdentityProvider;
  providerSubject: string;
  email: string;
  logger: FastifyBaseLogger;
}): Promise<OauthMfaChallenge> {
  const token = randomBytes(32).toString('base64url');
  const otp = await issueOtp('email', otpIdentifier(token));
  const challenge: OauthMfaChallenge = {
    token,
    userId: input.user.id,
    provider: input.provider,
    providerSubject: input.providerSubject,
    email: input.email,
    expiresInSec: env.OAUTH_MFA_TTL_SECONDS,
  };

  await redis.set(
    challengeKey(token),
    JSON.stringify({
      userId: challenge.userId,
      provider: challenge.provider,
      providerSubject: challenge.providerSubject,
      email: challenge.email,
    }),
    'EX',
    env.OAUTH_MFA_TTL_SECONDS,
  );

  await getEmailProvider().sendMfaOtpEmail({
    to: input.email,
    code: otp.code,
    expiresInSec: Math.min(otp.expiresInSec, env.OAUTH_MFA_TTL_SECONDS),
    logger: input.logger,
  });

  return challenge;
}

export async function consumeOauthMfaChallenge(input: {
  token: string;
  code: string;
}): Promise<Omit<OauthMfaChallenge, 'token' | 'expiresInSec'> | null> {
  const raw = await redis.get(challengeKey(input.token));
  if (!raw) return null;

  const ok = await verifyOtp('email', otpIdentifier(input.token), input.code);
  if (!ok) return null;

  await redis.del(challengeKey(input.token));
  const parsed = JSON.parse(raw) as {
    userId: string;
    provider: IdentityProvider;
    providerSubject: string;
    email: string;
  };

  return parsed;
}
