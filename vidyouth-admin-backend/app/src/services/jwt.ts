/**
 * JWT verification (RS256) — verify only.
 *
 * The admin service NEVER issues tokens. It validates the exact access
 * tokens the login API signs, using the shared public key + the same
 * issuer/audience. Private key is intentionally absent here.
 */

import { jwtVerify, importSPKI, type JWTPayload, type KeyLike } from 'jose';
import { env } from '../config/env.js';

let cachedPublicKey: KeyLike | null = null;

async function getPublicKey(): Promise<KeyLike> {
  if (cachedPublicKey) return cachedPublicKey;
  if (!env.JWT_PUBLIC_KEY) throw new Error('JWT_PUBLIC_KEY not configured');
  cachedPublicKey = await importSPKI(env.JWT_PUBLIC_KEY, 'RS256');
  return cachedPublicKey;
}

export interface AccessClaims extends JWTPayload {
  sub: string; // user id
  sid: string; // session id
  role: 'student' | 'admin' | 'vendor' | 'organisation' | 'superadmin';
  org?: string | undefined;
}

/** Verify an access token's signature, issuer, audience, and kind. */
export async function verifyAccess(token: string): Promise<AccessClaims> {
  const k = await getPublicKey();
  const { payload } = await jwtVerify(token, k, {
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  });
  if ((payload as { kind?: string }).kind !== 'access') {
    throw new Error('wrong_token_kind');
  }
  return payload as AccessClaims;
}
