/**
 * Vendor Management (PRD §7.5/§7.6/§8.5). Vendor accounts + offline
 * batches + per-batch assignment. Gated app.auth → requireAdminPanel →
 * requirePermission('manage_vendors').
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAdminPanel, requirePermission } from '../middleware/rbac.js';
import { recordAudit } from '../services/audit.js';
import * as v from '../repositories/vendors.js';

const idParam = z.object({ id: z.string().uuid() });

export async function vendorRoutes(app: FastifyInstance): Promise<void> {
  const gate = {
    preHandler: [app.auth, requireAdminPanel, requirePermission('manage_vendors')],
  };
  const guard = async (reply: FastifyReply, fn: () => Promise<unknown>) => {
    try { return await fn(); }
    catch (e) {
      if ((e as Error).name === 'NotFoundError') { reply.code(404).send({ error: 'not_found' }); return null; }
      throw e;
    }
  };
  const audit = (req: FastifyRequest,
    action: 'vendor.created' | 'vendor.updated' | 'batch.created' | 'batch.updated' | 'batch.vendor_assigned',
    meta: Record<string, unknown>) =>
    recordAudit({
      userId: req.user!.sub, action, ip: req.ip,
      userAgent: req.headers['user-agent'], meta, succeeded: true,
    });

  // ── Vendors ──
  app.get('/admin/vendors', gate, async (_q, r) => r.send({ vendors: await v.listVendors() }));
  app.post('/admin/vendors', gate, async (req, reply) => {
    const b = z.object({
      name: z.string().min(1).max(200),
      contactEmail: z.string().email().optional(),
      contactMobile: z.string().max(20).optional(),
      userId: z.string().uuid().optional(),
      organisationId: z.string().uuid().optional(),
    }).safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const row = await v.createVendor(b.data);
    await audit(req, 'vendor.created', { id: row.id });
    reply.code(201).send(row);
  });
  app.patch('/admin/vendors/:id', gate, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const b = z.object({
      name: z.string().min(1).max(200).optional(),
      contactEmail: z.string().email().optional(),
      contactMobile: z.string().max(20).optional(),
      isActive: z.boolean().optional(),
    }).safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const row = await guard(reply, () => v.updateVendor(p.data.id, b.data));
    if (row) { await audit(req, 'vendor.updated', { id: p.data.id }); reply.send(row); }
  });

  // ── Offline batches ──
  app.get('/admin/batches', gate, async (req, reply) => {
    const q = z.object({ vendorId: z.string().uuid().optional() }).safeParse(req.query);
    if (!q.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    reply.send({ batches: await v.listBatches(q.data.vendorId) });
  });
  app.post('/admin/batches', gate, async (req, reply) => {
    const b = z.object({
      name: z.string().min(1).max(200),
      topicId: z.string().uuid().optional(),
      vendorId: z.string().uuid().optional(),
      location: z.string().max(300).optional(),
      startDate: z.string().date().optional(),
      endDate: z.string().date().optional(),
      maxSeats: z.coerce.number().int().positive().optional(),
      hybridPct: z.coerce.number().int().min(0).max(100).optional(),
    }).safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const row = await v.createBatch(b.data);
    await audit(req, 'batch.created', { id: row.id });
    reply.code(201).send(row);
  });
  app.patch('/admin/batches/:id', gate, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const b = z.object({
      name: z.string().min(1).max(200).optional(),
      location: z.string().max(300).optional(),
      startDate: z.string().date().optional(),
      endDate: z.string().date().optional(),
      maxSeats: z.coerce.number().int().positive().optional(),
      hybridPct: z.coerce.number().int().min(0).max(100).optional(),
      status: z.enum(['scheduled', 'active', 'completed', 'cancelled']).optional(),
    }).safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const row = await guard(reply, () => v.updateBatch(p.data.id, b.data));
    if (row) { await audit(req, 'batch.updated', { id: p.data.id }); reply.send(row); }
  });
  app.post('/admin/batches/:id/assign-vendor', gate, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const b = z.object({ vendorId: z.string().uuid() }).safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const row = await guard(reply, () => v.assignVendor(p.data.id, b.data.vendorId));
    if (row) {
      await audit(req, 'batch.vendor_assigned',
        { batchId: p.data.id, vendorId: b.data.vendorId });
      reply.send(row);
    }
  });
}
