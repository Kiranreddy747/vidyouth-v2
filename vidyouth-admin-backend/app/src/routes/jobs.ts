/**
 * Job Portal (PRD §8.8 FR-JOB-001/002, §7.6 Job Portal). Post/edit/close
 * jobs + recommendation-threshold config. Gated app.auth →
 * requireAdminPanel → requirePermission('post_jobs').
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAdminPanel, requirePermission } from '../middleware/rbac.js';
import { recordAudit } from '../services/audit.js';
import * as j from '../repositories/jobs.js';

const idParam = z.object({ id: z.string().uuid() });

const jobBody = z.object({
  title: z.string().min(2).max(200),
  city: z.string().max(120).optional(),
  state: z.string().max(120).optional(),
  country: z.string().max(120).optional(),
  workMode: z.enum(['remote', 'hybrid', 'on_site']).optional(),
  salaryMin: z.coerce.number().min(0).optional(),
  salaryMax: z.coerce.number().min(0).optional(),
  salaryCurrency: z.string().max(8).optional(),
  isCompetitive: z.boolean().optional(),
  expMinYears: z.coerce.number().int().min(0).optional(),
  expMaxYears: z.coerce.number().int().min(0).optional(),
  requiredSkills: z.array(z.string().max(80)).max(50).optional(),
  requiredCertifications: z.array(z.string().max(80)).max(50).optional(),
  description: z.string().min(1).max(5000),
  applicationDeadline: z.string().date().optional(),
  externalUrl: z.string().url().optional(),
  visibility: z.enum(['public', 'org_specific', 'premium']).optional(),
});

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  const gate = {
    preHandler: [app.auth, requireAdminPanel, requirePermission('post_jobs')],
  };
  const guard = async (reply: FastifyReply, fn: () => Promise<unknown>) => {
    try { return await fn(); }
    catch (e) {
      if ((e as Error).name === 'NotFoundError') { reply.code(404).send({ error: 'not_found' }); return null; }
      throw e;
    }
  };

  app.get('/admin/jobs', gate, async (req, reply) => {
    const q = z.object({
      status: z.enum(['open', 'closed']).optional(),
      visibility: z.enum(['public', 'org_specific', 'premium']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).safeParse(req.query);
    if (!q.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    reply.send(await j.listJobs(q.data));
  });

  app.get('/admin/jobs/:id', gate, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const job = await j.getJob(p.data.id);
    if (!job) { reply.code(404).send({ error: 'not_found' }); return; }
    reply.send(job);
  });

  app.post('/admin/jobs', gate, async (req, reply) => {
    const b = jobBody.safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request', issues: b.error.flatten() }); return; }
    const u = req.user!;
    const row = await j.createJob(b.data, u.sub);
    await recordAudit({
      userId: u.sub, action: 'job.created', ip: req.ip,
      userAgent: req.headers['user-agent'], meta: { id: row.id, title: row.title },
      succeeded: true,
    });
    reply.code(201).send(row);
  });

  app.patch('/admin/jobs/:id', gate, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const b = jobBody.partial().extend({ status: z.enum(['open', 'closed']).optional() })
      .safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const row = await guard(reply, () => j.updateJob(p.data.id, b.data));
    if (row) {
      await recordAudit({
        userId: req.user!.sub, action: 'job.updated', ip: req.ip,
        userAgent: req.headers['user-agent'], meta: { id: p.data.id }, succeeded: true,
      });
      reply.send(row);
    }
  });

  app.post('/admin/jobs/:id/close', gate, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const row = await guard(reply, () => j.updateJob(p.data.id, { status: 'closed' }));
    if (row) {
      await recordAudit({
        userId: req.user!.sub, action: 'job.updated', ip: req.ip,
        userAgent: req.headers['user-agent'], meta: { id: p.data.id, op: 'close' },
        succeeded: true,
      });
      reply.send(row);
    }
  });

  app.get('/admin/jobs/settings/recommendation', gate, async (_q, reply) =>
    reply.send(await j.getRecoConfig()));

  app.patch('/admin/jobs/settings/recommendation', gate, async (req, reply) => {
    const b = z.object({ matchPct: z.coerce.number().int().min(1).max(100) }).safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const u = req.user!;
    const cfg = await j.setRecoConfig(b.data.matchPct, u.sub);
    await recordAudit({
      userId: u.sub, action: 'job.reco_config_changed', ip: req.ip,
      userAgent: req.headers['user-agent'], meta: cfg, succeeded: true,
    });
    reply.send(cfg);
  });
}
