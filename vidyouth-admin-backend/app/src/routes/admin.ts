/**
 * Admin Control Panel — backend foundation (standalone service).
 *
 * Scope: PRD §10 Admin Control Panel, §7.6 Super Admin, §16.1 RBAC.
 * This is the FOUNDATION — authenticated + RBAC-gated admin surface
 * with core dashboard stats, audit access, and the feature-toggle
 * store. The full panel (content CMS, pricing, payments, org approval,
 * certification, vendor mgmt, notification templates, analytics)
 * builds on top of this same `requireAdminPanel` gate.
 *
 * Every route: app.auth (valid, non-revoked session) THEN
 * requireAdminPanel (PRD §16.1 — superadmin only).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/pg.js';
import { requireAdminPanel } from '../middleware/rbac.js';
import { permissionsFor } from '../services/permissions.js';
import { recordAudit } from '../services/audit.js';
import { listFeatureFlags, setFeatureFlag } from '../repositories/feature-flags.js';

interface CountRow { n: string }

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const gate = { preHandler: [app.auth, requireAdminPanel] };

  /** Who am I + resolved permissions (FR-AUTH-003 role routing). */
  app.get('/admin/me', gate, async (req, reply) => {
    const u = req.user!;
    await recordAudit({
      userId: u.sub,
      action: 'admin.access',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: { path: '/admin/me' },
      succeeded: true,
    });
    const r = await query<{
      id: string; email: string | null; role: string;
      display_name: string | null; organisation_id: string | null;
    }>(
      `SELECT id, email, role, display_name, organisation_id
       FROM users WHERE id = $1 LIMIT 1`,
      [u.sub],
    );
    const me = r.rows[0];
    if (!me) { reply.code(404).send({ error: 'not_found' }); return; }
    reply.send({
      id: me.id,
      email: me.email,
      role: me.role,
      displayName: me.display_name,
      organisationId: me.organisation_id,
      permissions: permissionsFor(me.role),
    });
  });

  /** Dashboard widgets — PRD §10.1 (foundation set from existing data). */
  app.get('/admin/dashboard/stats', gate, async (_req, reply) => {
    const [byRole, newToday, activeSessions, pendingOrgs, failedLogins24h] =
      await Promise.all([
        query<{ role: string; n: string }>(
          `SELECT role, COUNT(*)::text AS n
           FROM users WHERE deleted_at IS NULL GROUP BY role`,
        ),
        query<CountRow>(
          `SELECT COUNT(*)::text AS n FROM users
           WHERE deleted_at IS NULL AND created_at >= NOW() - INTERVAL '24 hours'`,
        ),
        query<CountRow>(
          `SELECT COUNT(*)::text AS n FROM sessions
           WHERE created_at >= NOW() - INTERVAL '24 hours'`,
        ),
        query<CountRow>(
          `SELECT COUNT(*)::text AS n FROM organisations WHERE status = 'PENDING'`,
        ).catch(() => ({ rows: [{ n: '0' }] })),
        query<CountRow>(
          `SELECT COUNT(*)::text AS n FROM audit_events
           WHERE action = 'login.failed'
             AND occurred_at >= NOW() - INTERVAL '24 hours'`,
        ),
      ]);

    const usersByRole: Record<string, number> = {};
    let totalUsers = 0;
    for (const row of byRole.rows) {
      const v = Number(row.n);
      usersByRole[row.role] = v;
      totalUsers += v;
    }

    reply.send({
      generatedAt: new Date().toISOString(),
      totalRegisteredUsers: totalUsers,
      usersByRole,
      newUsersLast24h: Number(newToday.rows[0]?.n ?? 0),
      activeSessionsLast24h: Number(activeSessions.rows[0]?.n ?? 0),
      pendingOrgApprovals: Number(pendingOrgs.rows[0]?.n ?? 0),
      failedLoginsLast24h: Number(failedLogins24h.rows[0]?.n ?? 0),
    });
  });

  /** Audit log access — PRD §7.6 "view all system events". */
  const auditQuery = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    action: z.string().max(64).optional(),
  });
  app.get('/admin/audit', gate, async (req, reply) => {
    const parsed = auditQuery.safeParse(req.query);
    if (!parsed.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const { limit, action } = parsed.data;
    const rows = await query(
      `SELECT user_id, action, ip, succeeded, occurred_at
       FROM audit_events
       ${action ? 'WHERE action = $2' : ''}
       ORDER BY occurred_at DESC
       LIMIT $1`,
      action ? [limit, action] : [limit],
    );
    reply.send({ count: rows.rows.length, events: rows.rows });
  });

  /** Feature toggles — PRD §10.2. */
  app.get('/admin/feature-flags', gate, async (_req, reply) => {
    reply.send({ flags: await listFeatureFlags() });
  });

  const flagBody = z.object({ enabled: z.boolean() });
  app.patch('/admin/feature-flags/:key', gate, async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const parsed = flagBody.safeParse(req.body);
    if (!parsed.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const u = req.user!;
    const updated = await setFeatureFlag(key, parsed.data.enabled, u.sub);
    if (!updated) { reply.code(404).send({ error: 'unknown_flag' }); return; }
    await recordAudit({
      userId: u.sub,
      action: 'admin.feature_flag.changed',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: { key, enabled: parsed.data.enabled },
      succeeded: true,
    });
    reply.send(updated);
  });
}
