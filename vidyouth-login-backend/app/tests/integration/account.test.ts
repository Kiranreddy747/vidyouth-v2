import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { post, uniqueEmail, decodeJwt } from '../helpers.js';
import {
  hashVerificationToken,
} from '../../src/services/email-verification.js';
import { createVerificationToken } from '../../src/repositories/email-verification.js';
import { hashResetToken } from '../../src/services/password-reset.js';
import { createResetToken } from '../../src/repositories/password-reset.js';

async function signup(email: string, password = 'GoodPass123') {
  const r = await post('/auth/signup', {
    displayName: 'Acct', password, channel: 'email', email,
  });
  return decodeJwt(r.json<{ access_token: string }>().access_token).sub as string;
}

describe('email verification', () => {
  test('valid token marks the email verified, second use → 400', async () => {
    const email = uniqueEmail('ev');
    const userId = await signup(email);

    const raw = randomBytes(32).toString('base64url');
    await createVerificationToken({
      userId,
      tokenHash: hashVerificationToken(raw),
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const ok = await post('/auth/email-verify', { token: raw });
    assert.equal(ok.status, 200);
    assert.ok(ok.json<{ email_verified_at: string }>().email_verified_at);

    const replay = await post('/auth/email-verify', { token: raw });
    assert.equal(replay.status, 400);
  });

  test('unknown token → 400 invalid_or_expired_token', async () => {
    const r = await post('/auth/email-verify', {
      token: randomBytes(32).toString('base64url'),
    });
    assert.equal(r.status, 400);
    assert.equal(r.json<{ error: string }>().error, 'invalid_or_expired_token');
  });

  test('resend is a generic 202 for any email (no enumeration)', async () => {
    const known = await post('/auth/email-verify/resend', {
      email: uniqueEmail('rs'),
    });
    assert.equal(known.status, 202);
    const unknown = await post('/auth/email-verify/resend', {
      email: 'definitely-nobody@nowhere.test',
    });
    assert.equal(unknown.status, 202);
  });
});

describe('password reset', () => {
  test('request is a generic 202 even for unknown emails', async () => {
    const r = await post('/auth/password-reset/request', {
      email: 'nobody-here@nowhere.test',
    });
    assert.equal(r.status, 202);
  });

  test('valid token resets the password; old pw fails, new pw works; token single-use', async () => {
    const email = uniqueEmail('pr');
    const userId = await signup(email, 'OldPass123');

    const raw = randomBytes(32).toString('base64url');
    await createResetToken({
      userId,
      tokenHash: hashResetToken(raw),
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const confirm = await post('/auth/password-reset/confirm', {
      token: raw,
      newPassword: 'NewPass456',
    });
    assert.equal(confirm.status, 204);

    const oldLogin = await post('/auth/login', { identifier: email, password: 'OldPass123' });
    assert.equal(oldLogin.status, 401);

    const newLogin = await post('/auth/login', { identifier: email, password: 'NewPass456' });
    assert.equal(newLogin.status, 200);

    const replay = await post('/auth/password-reset/confirm', {
      token: raw,
      newPassword: 'AnotherPass789',
    });
    assert.equal(replay.status, 400);
  });

  test('weak new password → 400 weak_password', async () => {
    const email = uniqueEmail('prw');
    const userId = await signup(email);
    const raw = randomBytes(32).toString('base64url');
    await createResetToken({
      userId,
      tokenHash: hashResetToken(raw),
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const r = await post('/auth/password-reset/confirm', {
      token: raw,
      newPassword: 'weak',
    });
    assert.equal(r.status, 400);
  });

  test('same password rejects with same_password', async () => {
    const email = uniqueEmail('prs');
    const currentPassword = 'SamePass123';
    const userId = await signup(email, currentPassword);
    const raw = randomBytes(32).toString('base64url');
    await createResetToken({
      userId,
      tokenHash: hashResetToken(raw),
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const r = await post('/auth/password-reset/confirm', {
      token: raw,
      newPassword: currentPassword,
    });
    assert.equal(r.status, 400);
    assert.equal(r.json<{ error: string }>().error, 'same_password');
  });
});
