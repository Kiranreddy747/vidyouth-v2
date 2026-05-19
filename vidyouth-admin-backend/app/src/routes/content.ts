/**
 * Content Management (PRD §8.2 FR-CONTENT-001/002). Full CRUD over the
 * Sector → Sub-Sector → Topic → Subtopic (≤3) → Content-Item tree.
 * Gated app.auth → requireAdminPanel → requirePermission('create_edit_content').
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminPanel, requirePermission } from '../middleware/rbac.js';
import { recordAudit } from '../services/audit.js';
import * as c from '../repositories/content.js';

const idParam = z.object({ id: z.string().uuid() });

export async function contentRoutes(app: FastifyInstance): Promise<void> {
  const gate = {
    preHandler: [app.auth, requireAdminPanel, requirePermission('create_edit_content')],
  };

  const audit = async (req: import('fastify').FastifyRequest,
    action: 'content.created' | 'content.updated', entity: string, id: unknown) => {
    await recordAudit({
      userId: req.user!.sub,
      action,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: { entity, id },
      succeeded: true,
    });
  };

  const handle = async (
    reply: import('fastify').FastifyReply,
    fn: () => Promise<unknown>,
  ) => {
    try {
      return await fn();
    } catch (err) {
      const name = (err as Error).name;
      if (name === 'NotFoundError') { reply.code(404).send({ error: 'not_found' }); return null; }
      if (name === 'MaxDepthError') {
        reply.code(409).send({ error: 'max_subtopic_depth' }); return null;
      }
      if ((err as Error).message === 'exactly_one_parent') {
        reply.code(400).send({ error: 'exactly_one_parent' }); return null;
      }
      throw err;
    }
  };

  // ── Sectors ──
  const sectorBody = z.object({
    name: z.string().min(1).max(200),
    iconUrl: z.string().url().optional(),
    bannerUrl: z.string().url().optional(),
    sortOrder: z.coerce.number().int().optional(),
  });
  app.get('/admin/content/sectors', gate, async (_req, reply) =>
    reply.send({ sectors: await c.listSectors() }));
  app.post('/admin/content/sectors', gate, async (req, reply) => {
    const b = sectorBody.safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const row = await c.createSector(b.data);
    await audit(req, 'content.created', 'sector', row.id);
    reply.code(201).send(row);
  });
  app.patch('/admin/content/sectors/:id', gate, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const b = sectorBody.partial().extend({ isActive: z.boolean().optional() }).safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const row = await handle(reply, () => c.updateSector(p.data.id, b.data));
    if (row) { await audit(req, 'content.updated', 'sector', p.data.id); reply.send(row); }
  });

  // ── Sub-sectors ──
  app.get('/admin/content/sectors/:id/sub-sectors', gate, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    reply.send({ subSectors: await c.listSubSectors(p.data.id) });
  });
  const subBody = z.object({
    sectorId: z.string().uuid(),
    name: z.string().min(1).max(200),
    sortOrder: z.coerce.number().int().optional(),
  });
  app.post('/admin/content/sub-sectors', gate, async (req, reply) => {
    const b = subBody.safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const row = await handle(reply, () => c.createSubSector(b.data));
    if (row) { await audit(req, 'content.created', 'sub_sector', (row as { id: unknown }).id); reply.code(201).send(row); }
  });
  app.patch('/admin/content/sub-sectors/:id', gate, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const b = z.object({
      name: z.string().min(1).max(200).optional(),
      sectorId: z.string().uuid().optional(),
      sortOrder: z.coerce.number().int().optional(),
      isActive: z.boolean().optional(),
    }).safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const row = await handle(reply, () => c.updateSubSector(p.data.id, b.data));
    if (row) { await audit(req, 'content.updated', 'sub_sector', p.data.id); reply.send(row); }
  });

  // ── Topics ──
  app.get('/admin/content/sub-sectors/:id/topics', gate, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    reply.send({ topics: await c.listTopics(p.data.id) });
  });
  const topicBody = z.object({
    subSectorId: z.string().uuid(),
    name: z.string().min(1).max(200),
    description: z.string().max(5000).optional(),
    priceInr: z.coerce.number().min(0).optional(),
    isSubscription: z.boolean().optional(),
    validityDays: z.coerce.number().int().positive().optional(),
    sortOrder: z.coerce.number().int().optional(),
  });
  app.post('/admin/content/topics', gate, async (req, reply) => {
    const b = topicBody.safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const row = await handle(reply, () => c.createTopic(b.data));
    if (row) { await audit(req, 'content.created', 'topic', (row as { id: unknown }).id); reply.code(201).send(row); }
  });
  app.patch('/admin/content/topics/:id', gate, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const b = z.object({
      name: z.string().min(1).max(200).optional(),
      description: z.string().max(5000).optional(),
      priceInr: z.coerce.number().min(0).optional(),
      isSubscription: z.boolean().optional(),
      validityDays: z.coerce.number().int().positive().optional(),
      sortOrder: z.coerce.number().int().optional(),
      isActive: z.boolean().optional(),
    }).safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const row = await handle(reply, () => c.updateTopic(p.data.id, b.data));
    if (row) { await audit(req, 'content.updated', 'topic', p.data.id); reply.send(row); }
  });

  // ── Subtopics ──
  app.get('/admin/content/topics/:id/subtopics', gate, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    reply.send({ subtopics: await c.listSubtopics(p.data.id) });
  });
  const subtopicBody = z.object({
    topicId: z.string().uuid(),
    parentSubtopicId: z.string().uuid().optional(),
    name: z.string().min(1).max(200),
    sortOrder: z.coerce.number().int().optional(),
  });
  app.post('/admin/content/subtopics', gate, async (req, reply) => {
    const b = subtopicBody.safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const row = await handle(reply, () => c.createSubtopic(b.data));
    if (row) { await audit(req, 'content.created', 'subtopic', (row as { id: unknown }).id); reply.code(201).send(row); }
  });
  app.patch('/admin/content/subtopics/:id', gate, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const b = z.object({
      name: z.string().min(1).max(200).optional(),
      sortOrder: z.coerce.number().int().optional(),
      isActive: z.boolean().optional(),
    }).safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const row = await handle(reply, () => c.updateSubtopic(p.data.id, b.data));
    if (row) { await audit(req, 'content.updated', 'subtopic', p.data.id); reply.send(row); }
  });

  // ── Content items ──
  app.get('/admin/content/items', gate, async (req, reply) => {
    const q = z.object({
      topicId: z.string().uuid().optional(),
      subtopicId: z.string().uuid().optional(),
    }).safeParse(req.query);
    if (!q.success || (!q.data.topicId && !q.data.subtopicId)) {
      reply.code(400).send({ error: 'topicId_or_subtopicId_required' }); return;
    }
    reply.send({ items: await c.listItems(q.data) });
  });
  const itemBody = z.object({
    topicId: z.string().uuid().optional(),
    subtopicId: z.string().uuid().optional(),
    type: z.enum(['document', 'video', 'live_session', 'recorded_session',
      'offline_training', 'quiz', 'external_link']),
    title: z.string().min(1).max(300),
    config: z.record(z.unknown()).optional(),
    isDownloadable: z.boolean().optional(),
    sortOrder: z.coerce.number().int().optional(),
  });
  app.post('/admin/content/items', gate, async (req, reply) => {
    const b = itemBody.safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const row = await handle(reply, () => c.createItem(b.data));
    if (row) { await audit(req, 'content.created', 'item', (row as { id: unknown }).id); reply.code(201).send(row); }
  });
  app.patch('/admin/content/items/:id', gate, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const b = z.object({
      title: z.string().min(1).max(300).optional(),
      config: z.record(z.unknown()).optional(),
      isDownloadable: z.boolean().optional(),
      sortOrder: z.coerce.number().int().optional(),
      isActive: z.boolean().optional(),
    }).safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const row = await handle(reply, () => c.updateItem(p.data.id, b.data));
    if (row) { await audit(req, 'content.updated', 'item', p.data.id); reply.send(row); }
  });

  // ── Tree (admin UI) ──
  app.get('/admin/content/tree', gate, async (_req, reply) =>
    reply.send({ tree: await c.getTree() }));
}
