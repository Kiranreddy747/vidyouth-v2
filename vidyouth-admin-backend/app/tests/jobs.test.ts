import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { get, post, patch, makeSession } from './helpers.js';

/** M8 — Job Portal (PRD §8.8). post_jobs. */

interface Row { id: string; status?: string }

describe('jobs RBAC gate', () => {
  test('no token → 401', async () => {
    assert.equal((await get('/admin/jobs')).status, 401);
  });
  test('student → 403', async () => {
    const { token } = await makeSession('student');
    assert.equal((await get('/admin/jobs', token)).status, 403);
  });
});

describe('job portal (superadmin)', () => {
  test('create → patch → close, list filters, reco config', async () => {
    const { token } = await makeSession('superadmin');

    const create = await post('/admin/jobs', {
      title: 'Security Analyst',
      city: 'Bengaluru', country: 'India', workMode: 'hybrid',
      requiredSkills: ['SIEM', 'Incident Response'],
      requiredCertifications: ['Ethical Hacking'],
      description: 'Monitor and respond to security events.',
      visibility: 'public',
    }, token);
    assert.equal(create.status, 201);
    const id = create.json<Row>().id;

    const upd = await patch(`/admin/jobs/${id}`, { salaryMin: 800000, salaryMax: 1500000 }, token);
    assert.equal(upd.status, 200);

    const close = await post(`/admin/jobs/${id}/close`, {}, token);
    assert.equal(close.status, 200);
    assert.equal(close.json<Row>().status, 'closed');

    const list = await get('/admin/jobs?status=closed', token);
    assert.equal(list.status, 200);
    assert.ok(list.json<{ jobs: Row[] }>().jobs.some((x) => x.id === id));

    const cfg = await patch('/admin/jobs/settings/recommendation', { matchPct: 75 }, token);
    assert.equal(cfg.status, 200);
    assert.equal(cfg.json<{ matchPct: number }>().matchPct, 75);
    assert.equal((await get('/admin/jobs/settings/recommendation', token))
      .json<{ matchPct: number }>().matchPct, 75);
  });

  test('description over 5000 chars rejected', async () => {
    const { token } = await makeSession('superadmin');
    const r = await post('/admin/jobs',
      { title: 'X', description: 'a'.repeat(5001) }, token);
    assert.equal(r.status, 400);
  });

  test('unknown job → 404', async () => {
    const { token } = await makeSession('superadmin');
    assert.equal((await get('/admin/jobs/00000000-0000-0000-0000-000000000000', token)).status, 404);
  });
});
