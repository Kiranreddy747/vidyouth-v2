/**
 * Certification Engine (PRD §8.6, §7.6). Templates + per-topic issuance
 * rules + manual issue/revoke. Gated app.auth → requireAdminPanel →
 * requirePermission('issue_revoke_certificates').
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAdminPanel, requirePermission } from '../middleware/rbac.js';
import { recordAudit } from '../services/audit.js';
import * as cert from '../repositories/certification.js';

const idParam = z.object({ id: z.string().uuid() });
const topicParam = z.object({ topicId: z.string().uuid() });

export async function certificationRoutes(app: FastifyInstance): Promise<void> {
  const gate = {
    preHandler: [app.auth, requireAdminPanel, requirePermission('issue_revoke_certificates')],
  };
  const guard = async (reply: FastifyReply, fn: () => Promise<unknown>) => {
    try { return await fn(); }
    catch (e) {
      const n = (e as Error).name;
      if (n === 'NotFoundError') { reply.code(404).send({ error: 'not_found' }); return null; }
      if (n === 'InvalidStateError') { reply.code(409).send({ error: (e as Error).message }); return null; }
      throw e;
    }
  };
  const audit = (req: import('fastify').FastifyRequest,
    action: 'cert.template.changed' | 'cert.rule.changed' | 'cert.issued' | 'cert.revoked',
    meta: Record<string, unknown>) =>
    recordAudit({
      userId: req.user!.sub, action, ip: req.ip,
      userAgent: req.headers['user-agent'], meta, succeeded: true,
    });

  // ── Templates ──
  app.get('/admin/certification/templates', gate, async (_q, r) =>
    r.send({ templates: await cert.listTemplates() }));
  app.post('/admin/certification/templates', gate, async (req, reply) => {
    const b = z.object({
      name: z.string().min(1).max(120),
      config: z.record(z.unknown()).optional(),
      isDefault: z.boolean().optional(),
    }).safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const row = await cert.createTemplate(b.data);
    await audit(req, 'cert.template.changed', { id: row.id, op: 'create' });
    reply.code(201).send(row);
  });
  app.patch('/admin/certification/templates/:id', gate, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const b = z.object({
      name: z.string().min(1).max(120).optional(),
      config: z.record(z.unknown()).optional(),
      isDefault: z.boolean().optional(),
      isActive: z.boolean().optional(),
    }).safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const row = await guard(reply, () => cert.updateTemplate(p.data.id, b.data));
    if (row) { await audit(req, 'cert.template.changed', { id: p.data.id, op: 'update' }); reply.send(row); }
  });

  // ── Per-topic rule ──
  app.get('/admin/certification/rules/:topicId', gate, async (req, reply) => {
    const p = topicParam.safeParse(req.params);
    if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    reply.send(await cert.getRule(p.data.topicId) ?? { topic_id: p.data.topicId, default: true });
  });
  app.put('/admin/certification/rules/:topicId', gate, async (req, reply) => {
    const p = topicParam.safeParse(req.params);
    if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const b = z.object({
      minCompletionPct: z.coerce.number().int().min(0).max(100).optional(),
      minAssessmentPct: z.coerce.number().int().min(0).max(100).optional(),
      requiresOffline: z.boolean().optional(),
      expiryMode: z.enum(['lifetime', 'expiry']).optional(),
      validityDays: z.coerce.number().int().positive().optional(),
      templateId: z.string().uuid().optional(),
    }).safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const row = await guard(reply, () => cert.upsertRule(p.data.topicId, b.data, req.user!.sub));
    if (row) { await audit(req, 'cert.rule.changed', { topicId: p.data.topicId }); reply.send(row); }
  });

  // ── Certificates ──
  app.get('/admin/certification/certificates', gate, async (req, reply) => {
    const q = z.object({
      userId: z.string().uuid().optional(),
      topicId: z.string().uuid().optional(),
      status: z.enum(['active', 'revoked']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).safeParse(req.query);
    if (!q.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    reply.send(await cert.listCertificates(q.data));
  });
  app.post('/admin/certification/certificates', gate, async (req, reply) => {
    const b = z.object({
      userId: z.string().uuid(), topicId: z.string().uuid(),
    }).safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const row = await guard(reply, () => cert.issueCertificate(b.data.userId, b.data.topicId));
    if (row) {
      await audit(req, 'cert.issued',
        { userId: b.data.userId, topicId: b.data.topicId, certId: (row as { id: unknown }).id });
      reply.code(201).send(row);
    }
  });
  app.post('/admin/certification/certificates/:id/revoke', gate, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const b = z.object({ reason: z.string().min(3).max(300) }).safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'reason_required' }); return; }
    const row = await guard(reply, () => cert.revokeCertificate(p.data.id, req.user!.sub, b.data.reason));
    if (row) { await audit(req, 'cert.revoked', { certId: p.data.id, reason: b.data.reason }); reply.send(row); }
  });
}
