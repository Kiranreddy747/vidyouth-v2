/**
 * Notification Template Configuration (PRD §10.3). List/get/upsert
 * templates with per-channel toggles + variable substitution preview.
 * Gated app.auth → requireAdminPanel → requirePermission(
 * 'configure_feature_toggles')  (PRD §16.1 System Configuration).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminPanel, requirePermission } from '../middleware/rbac.js';
import { recordAudit } from '../services/audit.js';
import * as n from '../repositories/notifications.js';

const keyParam = z.object({ key: z.string().min(2).max(64).regex(/^[a-z0-9_]+$/) });

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  const gate = {
    preHandler: [app.auth, requireAdminPanel, requirePermission('configure_feature_toggles')],
  };

  app.get('/admin/notifications/templates', gate, async (_q, reply) =>
    reply.send({ supportedVariables: n.SUPPORTED_VARS, templates: await n.listTemplates() }));

  app.get('/admin/notifications/templates/:key', gate, async (req, reply) => {
    const p = keyParam.safeParse(req.params);
    if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const t = await n.getTemplate(p.data.key);
    if (!t) { reply.code(404).send({ error: 'not_found' }); return; }
    reply.send(t);
  });

  app.put('/admin/notifications/templates/:key', gate, async (req, reply) => {
    const p = keyParam.safeParse(req.params);
    if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const b = z.object({
      name: z.string().min(1).max(120).optional(),
      emailSubject: z.string().max(300).optional(),
      emailHtml: z.string().max(20000).optional(),
      emailEnabled: z.boolean().optional(),
      smsBody: z.string().max(800).optional(),
      smsEnabled: z.boolean().optional(),
      pushTitle: z.string().max(120).optional(),
      pushBody: z.string().max(400).optional(),
      pushEnabled: z.boolean().optional(),
    }).safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const u = req.user!;
    const row = await n.upsertTemplate(p.data.key, b.data, u.sub);
    await recordAudit({
      userId: u.sub, action: 'notification.template.changed', ip: req.ip,
      userAgent: req.headers['user-agent'], meta: { key: p.data.key }, succeeded: true,
    });
    reply.send(row);
  });

  app.post('/admin/notifications/templates/:key/preview', gate, async (req, reply) => {
    const p = keyParam.safeParse(req.params);
    if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const b = z.object({ sample: z.record(z.string()).optional() }).safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    try {
      reply.send(await n.previewTemplate(p.data.key, b.data.sample ?? {}));
    } catch (e) {
      if ((e as Error).name === 'NotFoundError') { reply.code(404).send({ error: 'not_found' }); return; }
      throw e;
    }
  });
}
