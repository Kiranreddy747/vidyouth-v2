/**
 * Organisation Management & Approval Workflow.
 *
 * PRD §FR-AUTH-002 (Organisation Account Registration — approval) and
 * §7.6 "Organisation Management": Super Admin creates / approves /
 * rejects / suspends organisations and configures the approval mode.
 *
 * Every route: app.auth → requireAdminPanel (superadmin only) →
 * requirePermission('manage_organisations'). RBAC enforced at the
 * service level, never client-side only (PRD §16.1).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminPanel, requirePermission } from '../middleware/rbac.js';
import { recordAudit } from '../services/audit.js';
import {
  approveOrganisation,
  createOrganisation,
  getApprovalMode,
  getOrganisation,
  InvalidTransitionError,
  listOrganisations,
  reactivateOrganisation,
  rejectOrganisation,
  setApprovalMode,
  suspendOrganisation,
  type OrgStatus,
} from '../repositories/organisations.js';

const ORG_STATUSES = ['PENDING', 'active', 'REJECTED', 'suspended', 'archived'] as const;

const listQuery = z.object({
  status: z.enum(ORG_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const idParam = z.object({ id: z.string().uuid() });

const createBody = z.object({
  name: z.string().min(2).max(200),
  kind: z.enum(['vendor', 'school', 'corporate', 'partner']),
  orgType: z.enum(['University', 'College', 'Corporate', 'NGO', 'Other']).optional(),
  contactName: z.string().max(200).optional(),
  officialEmail: z.string().email().optional(),
  contactMobile: z.string().max(20).optional(),
  domain: z.string().max(255).optional(),
  gstNumber: z.string().max(32).optional(),
  address: z.string().max(500).optional(),
  subAccountMax: z.coerce.number().int().min(0).max(100000).optional(),
});

const rejectBody = z.object({ reason: z.string().min(3).max(500) });
const modeBody = z.object({ mode: z.enum(['manual', 'auto']) });

export async function organisationRoutes(app: FastifyInstance): Promise<void> {
  const gate = {
    preHandler: [app.auth, requireAdminPanel, requirePermission('manage_organisations')],
  };

  /** List organisations, pending first (PRD §10.1 Pending Approvals). */
  app.get('/admin/organisations', gate, async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const { status, limit, offset } = parsed.data;
    const result = await listOrganisations({
      status: status as OrgStatus | undefined,
      limit,
      offset,
    });
    reply.send(result);
  });

  app.get('/admin/organisations/:id', gate, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const org = await getOrganisation(p.data.id);
    if (!org) { reply.code(404).send({ error: 'not_found' }); return; }
    reply.send(org);
  });

  /** Admin-created org — active immediately (PRD §7.6, bypasses approval). */
  app.post('/admin/organisations', gate, async (req, reply) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_request', issues: parsed.error.flatten() });
      return;
    }
    const u = req.user!;
    const org = await createOrganisation(parsed.data, u.sub);
    await recordAudit({
      userId: u.sub,
      organisationId: org.id,
      action: 'org.created',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: { name: org.name, org_code: org.org_code },
      succeeded: true,
    });
    reply.code(201).send(org);
  });

  const transition = (
    path: string,
    action: 'org.approved' | 'org.rejected' | 'org.suspended' | 'org.reactivated',
    fn: (id: string, adminId: string, reason: string) => Promise<unknown>,
    needsReason = false,
  ) => {
    app.post(`/admin/organisations/:id/${path}`, gate, async (req, reply) => {
      const p = idParam.safeParse(req.params);
      if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
      let reason = '';
      if (needsReason) {
        const b = rejectBody.safeParse(req.body);
        if (!b.success) { reply.code(400).send({ error: 'reason_required' }); return; }
        reason = b.data.reason;
      }
      const u = req.user!;
      try {
        const org = await fn(p.data.id, u.sub, reason);
        if (!org) { reply.code(404).send({ error: 'not_found' }); return; }
        await recordAudit({
          userId: u.sub,
          organisationId: p.data.id,
          action,
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          meta: needsReason ? { reason } : {},
          succeeded: true,
        });
        reply.send(org);
      } catch (err) {
        if (err instanceof InvalidTransitionError) {
          reply.code(409).send({ error: 'invalid_transition', from: err.from, to: err.to });
          return;
        }
        throw err;
      }
    });
  };

  transition('approve', 'org.approved', (id, adminId) => approveOrganisation(id, adminId));
  transition('reject', 'org.rejected',
    (id, adminId, reason) => rejectOrganisation(id, adminId, reason), true);
  transition('suspend', 'org.suspended', (id, adminId) => suspendOrganisation(id, adminId));
  transition('reactivate', 'org.reactivated', (id, adminId) => reactivateOrganisation(id, adminId));

  /** Approval mode config (PRD §FR-AUTH-002 — Auto-Approve | Manual Review). */
  app.get('/admin/settings/org-approval-mode', gate, async (_req, reply) => {
    reply.send({ mode: await getApprovalMode() });
  });

  app.patch('/admin/settings/org-approval-mode', gate, async (req, reply) => {
    const parsed = modeBody.safeParse(req.body);
    if (!parsed.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const u = req.user!;
    const mode = await setApprovalMode(parsed.data.mode, u.sub);
    await recordAudit({
      userId: u.sub,
      action: 'admin.setting.changed',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: { key: 'org_approval_mode', value: mode },
      succeeded: true,
    });
    reply.send({ mode });
  });
}
