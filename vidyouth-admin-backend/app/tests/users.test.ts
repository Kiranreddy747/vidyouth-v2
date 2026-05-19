import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { get, post, patch, makeSession } from './helpers.js';
import { redis } from '../src/db/redis.js';

/**
 * M2 — User Management (PRD §7.6, §FR-AUTH-003). Superadmin only.
 * Force-logout / unlock mirror the login API's Redis conventions, so
 * the tests assert the real end-to-end effect (revoked token → 401).
 */

interface User { id: string; is_active: boolean; role: string; locked?: boolean }

describe('users RBAC gate', () => {
  test('no token → 401', async () => {
    assert.equal((await get('/admin/users')).status, 401);
  });
  test('student session → 403', async () => {
    const { token } = await makeSession('student');
    assert.equal((await get('/admin/users', token)).status, 403);
  });
});

describe('user management (superadmin)', () => {
  test('list returns {total, users}', async () => {
    const { token } = await makeSession('superadmin');
    const r = await get('/admin/users?limit=5', token);
    assert.equal(r.status, 200);
    const b = r.json<{ total: number; users: User[] }>();
    assert.equal(typeof b.total, 'number');
    assert.ok(Array.isArray(b.users));
  });

  test('get user detail includes session count + locked; unknown → 404', async () => {
    const { token } = await makeSession('superadmin');
    const { userId } = await makeSession('student');
    const r = await get(`/admin/users/${userId}`, token);
    assert.equal(r.status, 200);
    const b = r.json<{ active_session_count: number; locked: boolean }>();
    assert.equal(typeof b.active_session_count, 'number');
    assert.equal(b.locked, false);
    assert.equal((await get(`/admin/users/${randomUUID()}`, token)).status, 404);
  });

  test('patch displayName + deactivate + reactivate', async () => {
    const { token } = await makeSession('superadmin');
    const { userId } = await makeSession('student');

    const upd = await patch(`/admin/users/${userId}`, { displayName: 'Renamed' }, token);
    assert.equal(upd.status, 200);

    const off = await post(`/admin/users/${userId}/deactivate`, {}, token);
    assert.equal(off.status, 200);
    assert.equal((await get(`/admin/users/${userId}`, token)).json<User>().is_active, false);

    const on = await post(`/admin/users/${userId}/reactivate`, {}, token);
    assert.equal(on.status, 200);
    assert.equal((await get(`/admin/users/${userId}`, token)).json<User>().is_active, true);
  });

  test('force-logout actually revokes the target session (token → 401)', async () => {
    const { token: actor } = await makeSession('superadmin');
    const { token: victim, userId } = await makeSession('superadmin');

    // Victim's superadmin token works before force-logout.
    assert.equal((await get('/admin/users?limit=1', victim)).status, 200);

    const fl = await post(`/admin/users/${userId}/force-logout`, {}, actor);
    assert.equal(fl.status, 200);

    // Session removed from Redis → authRequired now rejects the token.
    assert.equal((await get('/admin/users?limit=1', victim)).status, 401);
  });

  test('unlock clears a locked account', async () => {
    const { token } = await makeSession('superadmin');
    const { userId } = await makeSession('student');
    await redis.set(`lock:${userId}`, '1', 'EX', 1800);

    assert.equal((await get(`/admin/users/${userId}`, token)).json<User>().locked, true);
    const r = await post(`/admin/users/${userId}/unlock`, {}, token);
    assert.equal(r.status, 200);
    assert.equal((await get(`/admin/users/${userId}`, token)).json<User>().locked, false);
  });

  test('reset-password returns a login-compatible reset link', async () => {
    const { token } = await makeSession('superadmin');
    const { userId } = await makeSession('student');
    const r = await post(`/admin/users/${userId}/reset-password`, {}, token);
    assert.equal(r.status, 200);
    const b = r.json<{ resetUrl: string; expiresAt: string }>();
    assert.match(b.resetUrl, /\/reset-password\?token=/);
    assert.ok(new Date(b.expiresAt).getTime() > Date.now());
  });

  test('impersonate is 501 (admin is verify-only)', async () => {
    const { token } = await makeSession('superadmin');
    const { userId } = await makeSession('student');
    const r = await post(`/admin/users/${userId}/impersonate`, {}, token);
    assert.equal(r.status, 501);
    assert.equal(r.json<{ error: string }>().error, 'not_supported_here');
  });
});
