/**
 * Vidyouth Admin Control Panel API — standalone Fastify service.
 *
 * Separate from the login API (vidyouth-login-backend). Shares the
 * platform Postgres + Redis, verifies the login API's access tokens
 * (public key only), and exposes the RBAC-gated /admin surface on its
 * own port (default 8090).
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import { env, isProd } from './config/env.js';
import { closeDb } from './db/pg.js';
import { closeRedis } from './db/redis.js';
import { healthRoutes } from './routes/health.js';
import { adminRoutes } from './routes/admin.js';
import { organisationRoutes } from './routes/organisations.js';
import { userRoutes } from './routes/users.js';
import { contentRoutes } from './routes/content.js';
import { pricingRoutes } from './routes/pricing.js';
import { authRequired } from './middleware/auth.js';

declare module 'fastify' {
  interface FastifyInstance {
    auth: typeof authRequired;
  }
}

export interface BuildAppOptions {
  logger?: import('fastify').FastifyServerOptions['logger'];
}

export async function buildApp(opts: BuildAppOptions = {}) {
  const app = Fastify({
    logger: opts.logger ?? {
      level: env.LOG_LEVEL,
      ...(isProd
        ? {}
        : {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true, singleLine: true },
            },
          }),
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie'],
        censor: '[redacted]',
      },
    },
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });

  await app.register(sensible);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: isProd ? ['https://admin.vidyouth.com'] : true,
    credentials: true,
  });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });

  app.decorate('auth', authRequired);

  await app.register(healthRoutes);
  await app.register(adminRoutes);
  await app.register(organisationRoutes);
  await app.register(userRoutes);
  await app.register(contentRoutes);
  await app.register(pricingRoutes);

  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'unhandled error');
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    reply.code(status).send({ error: status >= 500 ? 'internal_error' : err.message });
  });

  return app;
}

async function start() {
  const app = await buildApp();
  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    app.log.info({ env: env.NODE_ENV, port: env.PORT }, 'vidyouth-admin-api ready');
  } catch (err) {
    app.log.fatal({ err }, 'failed to start');
    process.exit(1);
  }

  const shutdown = async (signal: NodeJS.Signals) => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await closeDb();
      await closeRedis();
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (env.NODE_ENV !== 'test') {
  start();
}
