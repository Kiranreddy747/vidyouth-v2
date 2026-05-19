import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { get, post, patch, makeSession } from './helpers.js';

/** M3 — Content CMS (PRD §8.2). Superadmin (create_edit_content) only. */

interface Row { id: string; is_active?: boolean }

describe('content RBAC gate', () => {
  test('no token → 401', async () => {
    assert.equal((await get('/admin/content/sectors')).status, 401);
  });
  test('student → 403', async () => {
    const { token } = await makeSession('student');
    assert.equal((await get('/admin/content/sectors', token)).status, 403);
  });
});

describe('content tree CRUD (superadmin)', () => {
  test('full hierarchy create → patch → tree, with depth limit', async () => {
    const { token } = await makeSession('superadmin');

    const sector = (await post('/admin/content/sectors',
      { name: 'IT' }, token)).json<Row>();
    assert.ok(sector.id);

    const sub = await post('/admin/content/sub-sectors',
      { sectorId: sector.id, name: 'Cybersecurity' }, token);
    assert.equal(sub.status, 201);
    const subId = sub.json<Row>().id;

    const topic = await post('/admin/content/topics',
      { subSectorId: subId, name: 'Network Security', priceInr: 1999, validityDays: 365 }, token);
    assert.equal(topic.status, 201);
    const topicId = topic.json<Row>().id;

    // Subtopic depth 1..3 ok, 4th rejected.
    const st1 = (await post('/admin/content/subtopics',
      { topicId, name: 'L1' }, token)).json<Row>();
    const st2 = (await post('/admin/content/subtopics',
      { topicId, parentSubtopicId: st1.id, name: 'L2' }, token)).json<Row>();
    const st3 = (await post('/admin/content/subtopics',
      { topicId, parentSubtopicId: st2.id, name: 'L3' }, token)).json<Row>();
    const tooDeep = await post('/admin/content/subtopics',
      { topicId, parentSubtopicId: st3.id, name: 'L4' }, token);
    assert.equal(tooDeep.status, 409);
    assert.equal(tooDeep.json<{ error: string }>().error, 'max_subtopic_depth');

    // Content item: exactly one parent.
    const bad = await post('/admin/content/items',
      { topicId, subtopicId: st1.id, type: 'document', title: 'x' }, token);
    assert.equal(bad.status, 400);
    const item = await post('/admin/content/items',
      { topicId, type: 'video', title: 'Intro', config: { url: 'https://x' } }, token);
    assert.equal(item.status, 201);

    // Patch (deactivate) a topic.
    const upd = await patch(`/admin/content/topics/${topicId}`, { isActive: false }, token);
    assert.equal(upd.status, 200);
    assert.equal(upd.json<Row>().is_active, false);

    // Tree reflects the structure.
    const tree = await get('/admin/content/tree', token);
    assert.equal(tree.status, 200);
    const t = tree.json<{ tree: Array<{ id: string; subSectors: unknown[] }> }>().tree;
    assert.ok(t.find((s) => s.id === sector.id));
  });

  test('patch unknown sector → 404', async () => {
    const { token } = await makeSession('superadmin');
    const r = await patch('/admin/content/sectors/00000000-0000-0000-0000-000000000000',
      { name: 'X' }, token);
    assert.equal(r.status, 404);
  });
});
