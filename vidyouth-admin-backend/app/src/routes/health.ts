/**
 * GET /healthz — liveness + dependency check (shared Postgres + Redis).
 * GET /livez   — cheap process-up probe.
 */

import type { FastifyInstance } from 'fastify';
import { pingDb } from '../db/pg.js';
import { pingRedis } from '../db/redis.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async (_req, reply) => {
    const [db, cache] = await Promise.all([pingDb(), pingRedis()]);
    const ok = db && cache;
    reply.code(ok ? 200 : 503).send({
      status: ok ? 'ok' : 'degraded',
      service: 'vidyouth-admin-api',
      uptimeSec: Math.round(process.uptime()),
      checks: { db, cache },
      version: process.env.GIT_SHA ?? 'dev',
    });
  });

  app.get('/livez', async (_req, reply) => {
    reply.send({ status: 'ok', service: 'vidyouth-admin-api' });
  });
}
