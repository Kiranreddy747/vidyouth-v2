import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { get, post, patch, makeSession } from './helpers.js';

/** M4 — Pricing & Subscriptions (PRD §9). Superadmin (configure_pricing). */

interface Row { id: string; is_active?: boolean }

async function makeTopic(token: string): Promise<string> {
  const s = (await post('/admin/content/sectors', { name: 'Fin' }, token)).json<Row>();
  const ss = (await post('/admin/content/sub-sectors',
    { sectorId: s.id, name: 'Banking' }, token)).json<Row>();
  const t = (await post('/admin/content/topics',
    { subSectorId: ss.id, name: 'Risk' }, token)).json<Row>();
  return t.id;
}

describe('pricing RBAC gate', () => {
  test('no token → 401', async () => {
    assert.equal((await get('/admin/pricing/plans')).status, 401);
  });
  test('student → 403', async () => {
    const { token } = await makeSession('student');
    assert.equal((await get('/admin/pricing/plans', token)).status, 403);
  });
});

describe('pricing config (superadmin)', () => {
  test('membership plans create + patch + list', async () => {
    const { token } = await makeSession('superadmin');
    const c = await post('/admin/pricing/plans',
      { name: 'Pro Annual', tier: 'pro', priceInr: 4999, billingPeriod: 'annual' }, token);
    assert.equal(c.status, 201);
    const id = c.json<Row>().id;
    const u = await patch(`/admin/pricing/plans/${id}`, { isActive: false }, token);
    assert.equal(u.json<Row>().is_active, false);
    assert.equal((await get('/admin/pricing/plans', token)).status, 200);
  });

  test('discount code: percentage > 100 rejected; valid created', async () => {
    const { token } = await makeSession('superadmin');
    const bad = await post('/admin/pricing/discount-codes',
      { code: `BAD${Date.now()}`, kind: 'percentage', value: 150 }, token);
    assert.equal(bad.status, 400);
    const ok = await post('/admin/pricing/discount-codes',
      { code: `SAVE${Date.now()}`, kind: 'percentage', value: 20 }, token);
    assert.equal(ok.status, 201);
  });

  test('per-topic pricing rule upsert (idempotent)', async () => {
    const { token } = await makeSession('superadmin');
    const topicId = await makeTopic(token);
    const a = await fetchPut(`/admin/pricing/topics/${topicId}`,
      { basePriceInr: 999, ppwPaisePerMin: 50 }, token);
    assert.equal(a.status, 200);
    const b = await fetchPut(`/admin/pricing/topics/${topicId}`,
      { validityDays: 365 }, token);
    assert.equal(b.status, 200);
  });

  test('org bulk pricing upsert; unknown ids → 404', async () => {
    const { token } = await makeSession('superadmin');
    const topicId = await makeTopic(token);
    const org = (await post('/admin/organisations',
      { name: `Bulk Co ${Date.now()}`, kind: 'corporate' }, token)).json<Row>();
    const ok = await fetchPut('/admin/pricing/org',
      { organisationId: org.id, topicId, priceInr: 499 }, token);
    assert.equal(ok.status, 200);
    const bad = await fetchPut('/admin/pricing/org',
      { organisationId: '00000000-0000-0000-0000-000000000000', topicId, priceInr: 1 }, token);
    assert.equal(bad.status, 404);
  });
});

// helpers.ts has get/post/patch; add a tiny PUT via app.inject through post-like
import { getApp } from './helpers.js';
async function fetchPut(path: string, body: unknown, token: string) {
  const app = await getApp();
  const res = await app.inject({
    method: 'PUT', url: path, payload: body,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  });
  return { status: res.statusCode, json: <T>() => JSON.parse(res.body) as T };
}
