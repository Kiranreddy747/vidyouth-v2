/**
 * Admin Analytics (PRD §17.3) + full Dashboard Widgets (§10.1).
 * Read-only. Gated app.auth → requireAdminPanel (PRD §16.1 "View
 * Platform Analytics" = Super Admin only).
 */

import type { FastifyInstance } from 'fastify';
import { requireAdminPanel } from '../middleware/rbac.js';
import * as a from '../repositories/analytics.js';

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  const gate = { preHandler: [app.auth, requireAdminPanel] };

  app.get('/admin/dashboard/widgets', gate, async (_q, reply) =>
    reply.send(await a.dashboardWidgets()));

  app.get('/admin/analytics/revenue', gate, async (_q, reply) =>
    reply.send(await a.revenue()));

  app.get('/admin/analytics/user-growth', gate, async (_q, reply) =>
    reply.send(await a.userGrowth()));

  app.get('/admin/analytics/certificates', gate, async (_q, reply) =>
    reply.send(await a.certificates()));

  app.get('/admin/analytics/wallet', gate, async (_q, reply) =>
    reply.send(await a.wallet()));

  app.get('/admin/analytics/content', gate, async (_q, reply) =>
    reply.send(await a.content()));

  app.get('/admin/analytics/vendors', gate, async (_q, reply) =>
    reply.send(await a.vendors()));
}
