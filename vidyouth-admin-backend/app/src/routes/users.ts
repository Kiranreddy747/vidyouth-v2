/**
 * User Management (PRD §7.6 "User Management" + §FR-AUTH-003).
 *
 * Create/edit/deactivate users, reset passwords, force-logout, manual
 * unlock. Gated app.auth → requireAdminPanel → requirePermission(
 * 'manage_all_users'). Impersonation is intentionally NOT performed here:
 * the admin service is verify-only (never signs tokens), so it returns
 * 501 and audits the attempt — token minting is the login API's job.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminPanel, requirePermission } from '../middleware/rbac.js';
import { recordAudit } from '../services/audit.js';
import {
  deactivateUser,
  forceLogout,
  getUser,
  issuePasswordReset,
  listUsers,
  reactivateUser,
  unlockUser,
  updateUser,
} from '../repositories/users.js';

const ROLES = ['student', 'admin', 'vendor', 'organisation', 'superadmin'] as const;

const listQuery = z.object({
  q: z.string().max(120).optional(),
  role: z.enum(ROLES).optional(),
  active: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const idParam = z.object({ id: z.string().uuid() });

const patchBody = z.object({
  displayName: z.string().min(1).max(200).optional(),
  role: z.enum(ROLES).optional(),
  isActive: z.boolean().optional(),
});

export async function userRoutes(app: FastifyInstance): Promise<void> {
  const gate = {
    preHandler: [app.auth, requireAdminPanel, requirePermission('manage_all_users')],
  };

  app.get('/admin/users', gate, async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const { q, role, active, limit, offset } = parsed.data;
    reply.send(
      await listUsers({
        q,
        role,
        active: active === undefined ? undefined : active === 'true',
        limit,
        offset,
      }),
    );
  });

  app.get('/admin/users/:id', gate, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const user = await getUser(p.data.id);
    if (!user) { reply.code(404).send({ error: 'not_found' }); return; }
    reply.send(user);
  });

  app.patch('/admin/users/:id', gate, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const b = patchBody.safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const u = req.user!;
    const updated = await updateUser(p.data.id, b.data);
    if (!updated) { reply.code(404).send({ error: 'not_found' }); return; }
    await recordAudit({
      userId: u.sub,
      action: 'user.updated',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: { target: p.data.id, patch: b.data },
      succeeded: true,
    });
    reply.send(updated);
  });

  const action = (
    path: string,
    auditAction:
      | 'user.deactivated' | 'user.reactivated' | 'user.force_logout' | 'user.unlocked',
    fn: (id: string) => Promise<unknown>,
  ) => {
    app.post(`/admin/users/:id/${path}`, gate, async (req, reply) => {
      const p = idParam.safeParse(req.params);
      if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
      const u = req.user!;
      const result = await fn(p.data.id);
      if (result === null || result === false) {
        reply.code(404).send({ error: 'not_found' });
        return;
      }
      await recordAudit({
        userId: u.sub,
        action: auditAction,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        meta: { target: p.data.id },
        succeeded: true,
      });
      reply.send({ ok: true, ...(typeof result === 'object' ? result : {}) });
    });
  };

  action('deactivate', 'user.deactivated', (id) => deactivateUser(id));
  action('reactivate', 'user.reactivated', (id) => reactivateUser(id));
  action('force-logout', 'user.force_logout', (id) => forceLogout(id));
  action('unlock', 'user.unlocked', (id) => unlockUser(id));

  app.post('/admin/users/:id/reset-password', gate, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const u = req.user!;
    const result = await issuePasswordReset(p.data.id);
    if (!result) { reply.code(404).send({ error: 'not_found' }); return; }
    await recordAudit({
      userId: u.sub,
      action: 'user.password_reset_issued',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: { target: p.data.id, expiresAt: result.expiresAt.toISOString() },
      succeeded: true,
    });
    reply.send(result);
  });

  /** PRD lists "impersonate users for support" but the admin service is
   *  verify-only by design — token minting belongs to the login API. */
  app.post('/admin/users/:id/impersonate', gate, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const u = req.user!;
    await recordAudit({
      userId: u.sub,
      action: 'user.impersonate_attempt',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: { target: p.data.id },
      succeeded: false,
    });
    reply.code(501).send({
      error: 'not_supported_here',
      message: 'Impersonation requires token issuance by the login API; the admin service is verify-only.',
    });
  });
}
