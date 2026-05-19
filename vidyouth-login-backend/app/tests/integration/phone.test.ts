import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { post, uniquePhone } from '../helpers.js';
import { issueOtp } from '../../src/services/otp.js';

async function signupPhone(phone: string): Promise<void> {
  const r = await post('/auth/signup', {
    displayName: 'Phone OTP',
    password: 'GoodPass123',
    channel: 'mobile',
    mobile: phone,
  });
  assert.equal(r.status, 200);
}

describe('phone OTP auth', () => {
  test('start with an existing E.164 number returns sent', async () => {
    const phone = uniquePhone();
    await signupPhone(phone);

    const r = await post('/auth/phone/start', { phone_number: phone });
    assert.equal(r.status, 200);
    assert.equal(r.json<{ status: string }>().status, 'sent');
  });

  test('start with an unknown phone rejects with account_not_found', async () => {
    const r = await post('/auth/phone/start', { phone_number: uniquePhone() });
    assert.equal(r.status, 404);
    assert.equal(r.json<{ error: string }>().error, 'account_not_found');
  });

  test('start with an invalid number returns invalid_phone_number', async () => {
    const r = await post('/auth/phone/start', { phone_number: 'not-a-number' });
    assert.equal(r.status, 400);
    assert.equal(r.json<{ error: string }>().error, 'invalid_phone_number');
  });

  test('verify with the correct code logs in the existing account', async () => {
    const phone = uniquePhone();
    await signupPhone(phone);

    const { code } = await issueOtp('sms', phone);
    const r = await post('/auth/phone/verify', { phone_number: phone, code });
    assert.equal(r.status, 200);
    assert.ok(r.json<{ access_token: string }>().access_token);
  });

  test('verify with the correct code for unknown phone rejects with account_not_found', async () => {
    const phone = uniquePhone();
    const { code } = await issueOtp('sms', phone);

    const r = await post('/auth/phone/verify', { phone_number: phone, code });
    assert.equal(r.status, 404);
    assert.equal(r.json<{ error: string }>().error, 'account_not_found');
  });

  test('verify with a wrong code returns invalid_phone_otp', async () => {
    const phone = uniquePhone();
    await signupPhone(phone);
    await issueOtp('sms', phone);

    const r = await post('/auth/phone/verify', { phone_number: phone, code: '000000' });
    assert.equal(r.status, 401);
    assert.equal(r.json<{ error: string }>().error, 'invalid_phone_otp');
  });

  test('verify with a malformed code returns 400', async () => {
    const r = await post('/auth/phone/verify', {
      phone_number: uniquePhone(),
      code: 'xx',
    });
    assert.equal(r.status, 400);
  });
});
