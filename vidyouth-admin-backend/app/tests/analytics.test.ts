import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { get, makeSession } from './helpers.js';

/** M10 — Admin Analytics §17.3 + Dashboard widgets §10.1. Superadmin. */

describe('analytics RBAC gate', () => {
  test('no token → 401', async () => {
    assert.equal((await get('/admin/analytics/revenue')).status, 401);
  });
  test('student → 403', async () => {
    const { token } = await makeSession('student');
    assert.equal((await get('/admin/dashboard/widgets', token)).status, 403);
  });
});

describe('analytics + dashboard (superadmin)', () => {
  test('dashboard widgets returns the §10.1 shape', async () => {
    const { token } = await makeSession('superadmin');
    const r = await get('/admin/dashboard/widgets', token);
    assert.equal(r.status, 200);
    const b = r.json<Record<string, unknown>>();
    for (const k of ['totalRegisteredUsers', 'usersByRole', 'gmvTodayPaise',
      'pendingOrgApprovals', 'failedPaymentsLast24h', 'certificatesIssuedLast24h']) {
      assert.ok(k in b, `missing widget ${k}`);
    }
  });

  test('all §17.3 report endpoints return 200 with expected keys', async () => {
    const { token } = await makeSession('superadmin');
    const rev = await get('/admin/analytics/revenue', token);
    assert.equal(rev.status, 200);
    assert.ok('byStatus' in rev.json<Record<string, unknown>>());

    const ug = await get('/admin/analytics/user-growth', token);
    assert.equal(ug.status, 200);
    assert.equal(typeof ug.json<{ activationRatePct: number }>().activationRatePct, 'number');

    for (const path of ['certificates', 'wallet', 'content', 'vendors']) {
      const r = await get(`/admin/analytics/${path}`, token);
      assert.equal(r.status, 200, `${path} not 200`);
    }
  });
});
