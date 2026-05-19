/**
 * Test helpers — in-process Fastify via app.inject() against the shared
 * Postgres + Redis. A SUPER_ADMIN session is minted by signing a real
 * access token with the same RS256 key the login API uses (test env
 * provides JWT_PRIVATE_KEY) and registering its session in Redis so the
 * isSessionActive() gate passes — exactly what a real login produces.
 */

import { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { SignJWT, importPKCS8 } from 'jose';
import { buildApp } from '../src/server.js';
import { closeDb, query } from '../src/db/pg.js';
import { redis, closeRedis } from '../src/db/redis.js';
import { env } from '../src/config/env.js';
import type { FastifyInstance } from 'fastify';

let appPromise: Promise<FastifyInstance> | null = null;

export async function getApp(): Promise<FastifyInstance> {
  if (!appPromise) {
    appPromise = buildApp({ logger: false }).then(async (app) => {
      await app.ready();
      return app;
    });
  }
  return appPromise;
}

after(async () => {
  try {
    if (appPromise) await (await appPromise).close();
  } catch {
    /* already closed */
  }
  await closeDb().catch(() => {});
  await closeRedis().catch(() => {});
});

let counter = 0;
export function uniqueEmail(tag = 't'): string {
  counter += 1;
  // randomUUID segment makes this unique even across the parallel test
  // processes node:test spawns per file (Date.now()+counter alone collide).
  return `admintest+${tag}.${Date.now()}.${counter}.${randomUUID().slice(0, 8)}@vidyouth.test`;
}

const PRIVATE_KEY = process.env.JWT_PRIVATE_KEY;

/** Create a real user row of the given role, mint a valid access token
 *  for it, and register the session in Redis (so it passes the gate). */
export async function makeSession(
  role: 'student' | 'superadmin',
): Promise<{ token: string; userId: string }> {
  if (!PRIVATE_KEY) {
    throw new Error('JWT_PRIVATE_KEY must be set in app/.env for the test suite');
  }
  const userId = randomUUID();
  const sid = randomUUID();
  const email = uniqueEmail(role);
  await query(
    `INSERT INTO users (id, role, email, password_hash, display_name)
     VALUES ($1, $2, $3, 'x', $4)`,
    [userId, role, email, `Admin Test ${role}`],
  );
  // Register the session the same way the login API does (ZSET sess:{uid}).
  await redis.zadd(`sess:${userId}`, Date.now(), sid);

  const key = await importPKCS8(PRIVATE_KEY, 'RS256');
  const token = await new SignJWT({ sub: userId, sid, role, kind: 'access' })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(key);

  return { token, userId };
}

interface InjectResult {
  status: number;
  json: <T = unknown>() => T;
  body: string;
}

export async function get(path: string, token?: string): Promise<InjectResult> {
  const app = await getApp();
  const res = await app.inject({
    method: 'GET',
    url: path,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.statusCode, body: res.body, json: <T>() => JSON.parse(res.body) as T };
}

export async function patch(
  path: string,
  body: unknown,
  token?: string,
): Promise<InjectResult> {
  const app = await getApp();
  const res = await app.inject({
    method: 'PATCH',
    url: path,
    payload: body,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  return { status: res.statusCode, body: res.body, json: <T>() => JSON.parse(res.body) as T };
}

export async function post(
  path: string,
  body: unknown,
  token?: string,
): Promise<InjectResult> {
  const app = await getApp();
  const res = await app.inject({
    method: 'POST',
    url: path,
    payload: body,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  return { status: res.statusCode, body: res.body, json: <T>() => JSON.parse(res.body) as T };
}
