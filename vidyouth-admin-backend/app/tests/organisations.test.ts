import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { get, post, patch, makeSession } from './helpers.js';
import { query } from '../src/db/pg.js';

/**
 * M1 — Organisation Management & Approval (PRD §FR-AUTH-002, §7.6).
 * Same RBAC contract as the rest of /admin: superadmin only.
 */

interface Org {
  id: string;
  status: string;
  org_code: string | null;
  name: string;
}

async function seedPendingOrg(): Promise<string> {
  const id = randomUUID();
  const slug = `pending-${id.slice(0, 8)}`;
  await query(
    `INSERT INTO organisations (id, slug, name, kind, status, submitted_at)
     VALUES ($1, $2, $3, 'school', 'PENDING', NOW())`,
    [id, slug, `Pending Org ${slug}`],
  );
  return id;
}

describe('organisations RBAC gate', () => {
  test('no token → 401', async () => {
    assert.equal((await get('/admin/organisations')).status, 401);
  });

  test('student session → 403', async () => {
    const { token } = await makeSession('student');
    assert.equal((await get('/admin/organisations', token)).status, 403);
  });
});

describe('organisation management (superadmin)', () => {
  // Hitting any org route once triggers the idempotent schema ensure,
  // so direct PENDING inserts below satisfy the widened status CHECK.
  before(async () => {
    const { token } = await makeSession('superadmin');
    await get('/admin/organisations', token);
  });

  test('create org → 201, active, with generated org_code', async () => {
    const { token } = await makeSession('superadmin');
    const r = await post(
      '/admin/organisations',
      { name: 'Acme University', kind: 'school', orgType: 'University' },
      token,
    );
    assert.equal(r.status, 201);
    const org = r.json<Org>();
    assert.equal(org.status, 'active');
    assert.ok(org.org_code && org.org_code.startsWith('VY-'));
  });

  test('list returns total + organisations, filterable by status', async () => {
    const { token } = await makeSession('superadmin');
    const r = await get('/admin/organisations?status=active&limit=10', token);
    assert.equal(r.status, 200);
    const b = r.json<{ total: number; organisations: Org[] }>();
    assert.equal(typeof b.total, 'number');
    assert.ok(Array.isArray(b.organisations));
  });

  test('approve a PENDING org → active + org_code', async () => {
    const { token } = await makeSession('superadmin');
    const id = await seedPendingOrg();
    const r = await post(`/admin/organisations/${id}/approve`, {}, token);
    assert.equal(r.status, 200);
    const org = r.json<Org>();
    assert.equal(org.status, 'active');
    assert.ok(org.org_code);
  });

  test('approving an already-active org → 409 invalid_transition', async () => {
    const { token } = await makeSession('superadmin');
    const id = await seedPendingOrg();
    await post(`/admin/organisations/${id}/approve`, {}, token);
    const again = await post(`/admin/organisations/${id}/approve`, {}, token);
    assert.equal(again.status, 409);
    assert.equal(again.json<{ error: string }>().error, 'invalid_transition');
  });

  test('reject requires a reason; valid reject → REJECTED', async () => {
    const { token } = await makeSession('superadmin');
    const id = await seedPendingOrg();
    assert.equal((await post(`/admin/organisations/${id}/reject`, {}, token)).status, 400);
    const r = await post(`/admin/organisations/${id}/reject`, { reason: 'incomplete docs' }, token);
    assert.equal(r.status, 200);
    assert.equal(r.json<Org>().status, 'REJECTED');
  });

  test('suspend then reactivate an active org', async () => {
    const { token } = await makeSession('superadmin');
    const id = await seedPendingOrg();
    await post(`/admin/organisations/${id}/approve`, {}, token);
    const s = await post(`/admin/organisations/${id}/suspend`, {}, token);
    assert.equal(s.json<Org>().status, 'suspended');
    const a = await post(`/admin/organisations/${id}/reactivate`, {}, token);
    assert.equal(a.json<Org>().status, 'active');
  });

  test('unknown id → 404', async () => {
    const { token } = await makeSession('superadmin');
    const r = await get(`/admin/organisations/${randomUUID()}`, token);
    assert.equal(r.status, 404);
  });

  test('approval mode get + set + restore', async () => {
    const { token } = await makeSession('superadmin');
    const init = await get('/admin/settings/org-approval-mode', token);
    assert.equal(init.status, 200);
    assert.ok(['manual', 'auto'].includes(init.json<{ mode: string }>().mode));

    const set = await patch('/admin/settings/org-approval-mode', { mode: 'auto' }, token);
    assert.equal(set.json<{ mode: string }>().mode, 'auto');

    const restore = await patch('/admin/settings/org-approval-mode', { mode: 'manual' }, token);
    assert.equal(restore.json<{ mode: string }>().mode, 'manual');
  });
});
