import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { get, post, patch, makeSession } from './helpers.js';

/** M7 — Vendor Management (PRD §7.5/§7.6). manage_vendors. */

interface Row { id: string; vendor_id?: string; is_active?: boolean }

describe('vendors RBAC gate', () => {
  test('no token → 401', async () => {
    assert.equal((await get('/admin/vendors')).status, 401);
  });
  test('student → 403', async () => {
    const { token } = await makeSession('student');
    assert.equal((await get('/admin/vendors', token)).status, 403);
  });
});

describe('vendor + batch management (superadmin)', () => {
  test('create vendor, create batch, assign vendor', async () => {
    const { token } = await makeSession('superadmin');

    const vend = await post('/admin/vendors',
      { name: 'SkillForge', contactEmail: 'ops@skillforge.test' }, token);
    assert.equal(vend.status, 201);
    const vendorId = vend.json<Row>().id;

    assert.equal((await patch(`/admin/vendors/${vendorId}`,
      { contactMobile: '+919000000000' }, token)).status, 200);

    const batch = await post('/admin/batches',
      { name: 'Batch Jan', location: 'Hyderabad', hybridPct: 40 }, token);
    assert.equal(batch.status, 201);
    const batchId = batch.json<Row>().id;

    const assign = await post(`/admin/batches/${batchId}/assign-vendor`,
      { vendorId }, token);
    assert.equal(assign.status, 200);
    assert.equal(assign.json<Row>().vendor_id, vendorId);

    const list = await get(`/admin/batches?vendorId=${vendorId}`, token);
    assert.equal(list.status, 200);
    assert.ok(list.json<{ batches: Row[] }>().batches.some((b) => b.id === batchId));
  });

  test('assign unknown vendor → 404', async () => {
    const { token } = await makeSession('superadmin');
    const batch = await post('/admin/batches', { name: 'B2' }, token);
    const r = await post(`/admin/batches/${batch.json<Row>().id}/assign-vendor`,
      { vendorId: '00000000-0000-0000-0000-000000000000' }, token);
    assert.equal(r.status, 404);
  });
});
