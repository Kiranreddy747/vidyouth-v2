import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { get, post, patch, makeSession, getApp } from './helpers.js';

/** M6 — Certification Engine (PRD §8.6). issue_revoke_certificates. */

interface Row { id: string }

async function put(path: string, body: unknown, token: string) {
  const app = await getApp();
  const res = await app.inject({
    method: 'PUT', url: path, payload: body,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  });
  return { status: res.statusCode, json: <T>() => JSON.parse(res.body) as T };
}
async function makeTopic(token: string): Promise<string> {
  const s = (await post('/admin/content/sectors', { name: 'Cert' }, token)).json<Row>();
  const ss = (await post('/admin/content/sub-sectors',
    { sectorId: s.id, name: 'CS' }, token)).json<Row>();
  return (await post('/admin/content/topics',
    { subSectorId: ss.id, name: 'Ethical Hacking' }, token)).json<Row>().id;
}

describe('certification RBAC gate', () => {
  test('no token → 401', async () => {
    assert.equal((await get('/admin/certification/templates')).status, 401);
  });
  test('student → 403', async () => {
    const { token } = await makeSession('student');
    assert.equal((await get('/admin/certification/templates', token)).status, 403);
  });
});

describe('certification engine (superadmin)', () => {
  test('template create/patch, per-topic rule upsert, issue + revoke', async () => {
    const { token } = await makeSession('superadmin');
    const { userId } = await makeSession('student');
    const topicId = await makeTopic(token);

    const tpl = await post('/admin/certification/templates',
      { name: 'Default', config: { color: '#0af' }, isDefault: true }, token);
    assert.equal(tpl.status, 201);
    const tplId = tpl.json<Row>().id;
    assert.equal((await patch(`/admin/certification/templates/${tplId}`,
      { name: 'Default v2' }, token)).status, 200);

    const rule = await put(`/admin/certification/rules/${topicId}`,
      { minCompletionPct: 90, expiryMode: 'expiry', validityDays: 365, templateId: tplId }, token);
    assert.equal(rule.status, 200);
    assert.equal(rule.json<{ min_completion_pct: number }>().min_completion_pct, 90);

    const issued = await post('/admin/certification/certificates',
      { userId, topicId }, token);
    assert.equal(issued.status, 201);
    const certId = issued.json<{ id: string; status: string; expires_at: string }>().id;
    assert.ok(issued.json<{ expires_at: string }>().expires_at);

    const rev = await post(`/admin/certification/certificates/${certId}/revoke`,
      { reason: 'mistake' }, token);
    assert.equal(rev.status, 200);
    assert.equal(rev.json<{ status: string }>().status, 'revoked');

    const again = await post(`/admin/certification/certificates/${certId}/revoke`,
      { reason: 'again' }, token);
    assert.equal(again.status, 409);

    const list = await get(`/admin/certification/certificates?status=revoked`, token);
    assert.equal(list.status, 200);
    assert.ok(list.json<{ total: number }>().total >= 1);
  });

  test('issue for unknown topic → 404', async () => {
    const { token } = await makeSession('superadmin');
    const { userId } = await makeSession('student');
    const r = await post('/admin/certification/certificates',
      { userId, topicId: '00000000-0000-0000-0000-000000000000' }, token);
    assert.equal(r.status, 404);
  });
});
