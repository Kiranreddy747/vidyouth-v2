import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { get, post, makeSession, getApp } from './helpers.js';

/** M9 — Notification Templates (PRD §10.3). configure_feature_toggles. */

async function put(path: string, body: unknown, token: string) {
  const app = await getApp();
  const res = await app.inject({
    method: 'PUT', url: path, payload: body,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  });
  return { status: res.statusCode, json: <T>() => JSON.parse(res.body) as T };
}

describe('notifications RBAC gate', () => {
  test('no token → 401', async () => {
    assert.equal((await get('/admin/notifications/templates')).status, 401);
  });
  test('student → 403', async () => {
    const { token } = await makeSession('student');
    assert.equal((await get('/admin/notifications/templates', token)).status, 403);
  });
});

describe('notification templates (superadmin)', () => {
  test('list seeds defaults + exposes supported variables', async () => {
    const { token } = await makeSession('superadmin');
    const r = await get('/admin/notifications/templates', token);
    assert.equal(r.status, 200);
    const b = r.json<{ supportedVariables: string[]; templates: unknown[] }>();
    assert.ok(b.supportedVariables.includes('user_name'));
    assert.ok(b.templates.length >= 3);
  });

  test('edit channels + preview substitutes variables and flags SMS overflow', async () => {
    const { token } = await makeSession('superadmin');
    const upd = await put('/admin/notifications/templates/welcome',
      { smsEnabled: true, smsBody: 'Hi {{user_name}}, welcome!' }, token);
    assert.equal(upd.status, 200);

    const pv = await post('/admin/notifications/templates/welcome/preview',
      { sample: { user_name: 'Asha' } }, token);
    assert.equal(pv.status, 200);
    const body = pv.json<{
      email: { subject: string }; sms: { body: string; overflow: boolean; enabled: boolean };
    }>();
    assert.match(body.email.subject, /Asha/);
    assert.equal(body.sms.body, 'Hi Asha, welcome!');
    assert.equal(body.sms.enabled, true);
    assert.equal(body.sms.overflow, false);
  });

  test('long SMS flagged as overflow (>160)', async () => {
    const { token } = await makeSession('superadmin');
    await put('/admin/notifications/templates/welcome',
      { smsBody: 'x'.repeat(200) }, token);
    const pv = await post('/admin/notifications/templates/welcome/preview', {}, token);
    assert.equal(pv.json<{ sms: { overflow: boolean } }>().sms.overflow, true);
  });

  test('preview unknown template → 404', async () => {
    const { token } = await makeSession('superadmin');
    assert.equal((await post('/admin/notifications/templates/nope_x/preview', {}, token)).status, 404);
  });
});
