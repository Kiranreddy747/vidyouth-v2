import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { post, uniqueEmail } from '../helpers.js';
import { issueOtp } from '../../src/services/otp.js';

/**
 * OTP login is for users that already exist. We sign the user up, then
 * mint a real OTP via the service (deterministic — no log scraping) and
 * drive the verify route.
 */
describe('email OTP login', () => {
  test('request → 200 sent', async () => {
    const email = uniqueEmail('otpreq');
    await post('/auth/signup', {
      displayName: 'OTP', password: 'GoodPass123', channel: 'email', email,
    });
    const r = await post('/auth/otp/request', { channel: 'email', identifier: email });
    assert.equal(r.status, 200);
    assert.equal(r.json<{ status: string }>().status, 'sent');
  });

  test('request for unknown email rejects with account_not_found', async () => {
    const r = await post('/auth/otp/request', {
      channel: 'email',
      identifier: uniqueEmail('otpnew'),
    });
    assert.equal(r.status, 404);
    assert.equal(r.json<{ error: string }>().error, 'account_not_found');
  });

  test('correct code logs the existing user in', async () => {
    const email = uniqueEmail('otpok');
    await post('/auth/signup', {
      displayName: 'OTP', password: 'GoodPass123', channel: 'email', email,
    });
    const { code } = await issueOtp('email', email);
    const r = await post('/auth/otp/verify', { channel: 'email', identifier: email, code });
    assert.equal(r.status, 200);
    assert.ok(r.json<{ access_token: string }>().access_token);
  });

  test('wrong code → 401 invalid_otp', async () => {
    const email = uniqueEmail('otpbad');
    await post('/auth/signup', {
      displayName: 'OTP', password: 'GoodPass123', channel: 'email', email,
    });
    await issueOtp('email', email);
    const r = await post('/auth/otp/verify', {
      channel: 'email', identifier: email, code: '000000',
    });
    assert.equal(r.status, 401);
    assert.equal(r.json<{ error: string }>().error, 'invalid_otp');
  });

  test('code is single-use (replay → 401)', async () => {
    const email = uniqueEmail('otprep');
    await post('/auth/signup', {
      displayName: 'OTP', password: 'GoodPass123', channel: 'email', email,
    });
    const { code } = await issueOtp('email', email);
    const first = await post('/auth/otp/verify', { channel: 'email', identifier: email, code });
    assert.equal(first.status, 200);
    const replay = await post('/auth/otp/verify', { channel: 'email', identifier: email, code });
    assert.equal(replay.status, 401);
  });

  test('malformed code → 400', async () => {
    const r = await post('/auth/otp/verify', {
      channel: 'email', identifier: uniqueEmail('m'), code: 'abc',
    });
    assert.equal(r.status, 400);
  });
});
