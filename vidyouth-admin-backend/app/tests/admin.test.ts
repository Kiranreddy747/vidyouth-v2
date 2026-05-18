import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { get, patch, makeSession } from './helpers.js';

/**
 * Standalone admin service. Proves the server-side RBAC gate: only a
 * superadmin session (valid token + active Redis session) reaches
 * /admin/*; everyone else is rejected with 401/403 before the handler.
 */
describe('admin RBAC gate', () => {
  test('no token → 401', async () => {
    assert.equal((await get('/admin/me')).status, 401);
  });

  test('student session → 403 (lacks access_admin_panel)', async () => {
    const { token } = await makeSession('student');
    const r = await get('/admin/me', token);
    assert.equal(r.status, 403);
    assert.equal(r.json<{ error: string }>().error, 'forbidden');
  });

  test('superadmin session → 200 with resolved permissions', async () => {
    const { token } = await makeSession('superadmin');
    const r = await get('/admin/me', token);
    assert.equal(r.status, 200);
    const b = r.json<{ role: string; permissions: string[] }>();
    assert.equal(b.role, 'superadmin');
    assert.ok(b.permissions.includes('access_admin_panel'));
  });
});

describe('admin dashboard + feature flags (superadmin only)', () => {
  test('dashboard stats returns the §10.1 widget shape', async () => {
    const { token } = await makeSession('superadmin');
    const r = await get('/admin/dashboard/stats', token);
    assert.equal(r.status, 200);
    const b = r.json<Record<string, unknown>>();
    assert.equal(typeof b.totalRegisteredUsers, 'number');
    assert.equal(typeof b.usersByRole, 'object');
    assert.ok('failedLoginsLast24h' in b);
  });

  test('feature flags list + toggle + restore', async () => {
    const { token } = await makeSession('superadmin');
    const list = await get('/admin/feature-flags', token);
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.json<{ flags: unknown[] }>().flags));

    const off = await patch('/admin/feature-flags/lms_module', { enabled: false }, token);
    assert.equal(off.status, 200);
    assert.equal(off.json<{ enabled: boolean }>().enabled, false);

    const on = await patch('/admin/feature-flags/lms_module', { enabled: true }, token);
    assert.equal(on.json<{ enabled: boolean }>().enabled, true);
  });

  test('unknown flag → 404', async () => {
    const { token } = await makeSession('superadmin');
    const r = await patch('/admin/feature-flags/no_such_flag', { enabled: false }, token);
    assert.equal(r.status, 404);
  });

  test('student cannot read dashboard stats → 403', async () => {
    const { token } = await makeSession('student');
    assert.equal((await get('/admin/dashboard/stats', token)).status, 403);
  });

  test('audit log endpoint returns events for superadmin', async () => {
    const { token } = await makeSession('superadmin');
    const r = await get('/admin/audit?limit=5', token);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json<{ events: unknown[] }>().events));
  });
});
