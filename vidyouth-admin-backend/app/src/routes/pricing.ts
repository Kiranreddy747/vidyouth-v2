/**
 * Pricing & Subscriptions (PRD §9.1/§9.2). Membership plans, discount
 * codes, per-topic pricing rules, org bulk pricing.
 * Gated app.auth → requireAdminPanel → requirePermission('configure_pricing').
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAdminPanel, requirePermission } from '../middleware/rbac.js';
import { recordAudit } from '../services/audit.js';
import * as p from '../repositories/pricing.js';

const idParam = z.object({ id: z.string().uuid() });

export async function pricingRoutes(app: FastifyInstance): Promise<void> {
  const gate = {
    preHandler: [app.auth, requireAdminPanel, requirePermission('configure_pricing')],
  };
  const audit = (req: FastifyRequest, entity: string, meta: Record<string, unknown>) =>
    recordAudit({
      userId: req.user!.sub, action: 'pricing.changed',
      ip: req.ip, userAgent: req.headers['user-agent'],
      meta: { entity, ...meta }, succeeded: true,
    });
  const guard = async (reply: import('fastify').FastifyReply, fn: () => Promise<unknown>) => {
    try { return await fn(); }
    catch (e) {
      if ((e as Error).name === 'NotFoundError') { reply.code(404).send({ error: 'not_found' }); return null; }
      throw e;
    }
  };

  // ── Membership plans ──
  app.get('/admin/pricing/plans', gate, async (_q, r) =>
    r.send({ plans: await p.listPlans() }));
  const planBody = z.object({
    name: z.string().min(1).max(120),
    tier: z.enum(['basic', 'pro', 'premium']),
    priceInr: z.coerce.number().min(0),
    billingPeriod: z.enum(['monthly', 'annual', 'lifetime']),
    features: z.array(z.unknown()).optional(),
    autoRenew: z.boolean().optional(),
  });
  app.post('/admin/pricing/plans', gate, async (req, reply) => {
    const b = planBody.safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const row = await p.createPlan(b.data);
    await audit(req, 'plan', { id: row.id, op: 'create' });
    reply.code(201).send(row);
  });
  app.patch('/admin/pricing/plans/:id', gate, async (req, reply) => {
    const pp = idParam.safeParse(req.params);
    if (!pp.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const b = planBody.partial().extend({ isActive: z.boolean().optional() }).safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const row = await guard(reply, () => p.updatePlan(pp.data.id, b.data));
    if (row) { await audit(req, 'plan', { id: pp.data.id, op: 'update' }); reply.send(row); }
  });

  // ── Discount codes ──
  app.get('/admin/pricing/discount-codes', gate, async (_q, r) =>
    r.send({ codes: await p.listCodes() }));
  const codeBody = z.object({
    code: z.string().min(2).max(40),
    kind: z.enum(['percentage', 'fixed']),
    value: z.coerce.number().positive(),
    expiresAt: z.string().datetime().optional(),
    usageLimit: z.coerce.number().int().positive().optional(),
    perUserLimit: z.coerce.number().int().positive().optional(),
  });
  app.post('/admin/pricing/discount-codes', gate, async (req, reply) => {
    const b = codeBody.safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    if (b.data.kind === 'percentage' && b.data.value > 100) {
      reply.code(400).send({ error: 'percentage_over_100' }); return;
    }
    const row = await p.createCode(b.data);
    await audit(req, 'discount_code', { id: row.id, op: 'create' });
    reply.code(201).send(row);
  });
  app.patch('/admin/pricing/discount-codes/:id', gate, async (req, reply) => {
    const pp = idParam.safeParse(req.params);
    if (!pp.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const b = z.object({
      value: z.coerce.number().positive().optional(),
      expiresAt: z.string().datetime().optional(),
      usageLimit: z.coerce.number().int().positive().optional(),
      perUserLimit: z.coerce.number().int().positive().optional(),
      isActive: z.boolean().optional(),
    }).safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const row = await guard(reply, () => p.updateCode(pp.data.id, b.data));
    if (row) { await audit(req, 'discount_code', { id: pp.data.id, op: 'update' }); reply.send(row); }
  });

  // ── Per-topic pricing rule (upsert) ──
  app.put('/admin/pricing/topics/:id', gate, async (req, reply) => {
    const pp = idParam.safeParse(req.params);
    if (!pp.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const b = z.object({
      basePriceInr: z.coerce.number().min(0).optional(),
      validityDays: z.coerce.number().int().positive().optional(),
      earlyBirdPriceInr: z.coerce.number().min(0).optional(),
      earlyBirdUntil: z.string().datetime().optional(),
      ppwPaisePerMin: z.coerce.number().int().min(0).optional(),
    }).safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const row = await guard(reply, () => p.upsertTopicPricing(pp.data.id, b.data, req.user!.sub));
    if (row) { await audit(req, 'topic_pricing', { topicId: pp.data.id }); reply.send(row); }
  });

  // ── Org bulk pricing (upsert) ──
  app.put('/admin/pricing/org', gate, async (req, reply) => {
    const b = z.object({
      organisationId: z.string().uuid(),
      topicId: z.string().uuid(),
      priceInr: z.coerce.number().min(0),
    }).safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const row = await guard(reply,
      () => p.upsertOrgPricing(b.data.organisationId, b.data.topicId, b.data.priceInr));
    if (row) {
      await audit(req, 'org_pricing',
        { organisationId: b.data.organisationId, topicId: b.data.topicId });
      reply.send(row);
    }
  });
}
