/**
 * RBAC preHandlers. Compose AFTER authRequired so req.user is set, then
 * reject with 403 before the route body. Service-level half of the PRD's
 * "RBAC enforced at API gateway AND service level — never client-side only".
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { can, type Permission, type Role } from '../services/permissions.js';
import { recordAudit } from '../services/audit.js';

export function requirePermission(permission: Permission) {
  return async function (req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const u = req.user;
    if (!u) {
      reply.code(401).send({ error: 'unauthenticated' });
      return;
    }
    if (!can(u.role as Role, permission)) {
      await recordAudit({
        userId: u.sub,
        action: 'admin.access.denied',
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        meta: { denied_permission: permission, role: u.role, path: req.url },
        succeeded: false,
      });
      reply.code(403).send({ error: 'forbidden', required: permission });
      return;
    }
  };
}

export function requireRole(...roles: Role[]) {
  return async function (req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const u = req.user;
    if (!u) {
      reply.code(401).send({ error: 'unauthenticated' });
      return;
    }
    if (!roles.includes(u.role as Role)) {
      reply.code(403).send({ error: 'forbidden', required_roles: roles });
      return;
    }
  };
}

/** Platform admin-panel gate (PRD §16.1 — superadmin only). */
export const requireAdminPanel = requirePermission('access_admin_panel');
