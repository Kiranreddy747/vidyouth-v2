/**
 * Auth middleware. Extracts the Bearer access token issued by the login
 * API, verifies its signature/issuer/audience, then confirms the session
 * is still active in the shared Redis (so logout / force-logout also
 * locks the admin panel). Attaches a typed req.user.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyAccess, type AccessClaims } from '../services/jwt.js';
import { isSessionActive } from '../db/redis.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AccessClaims;
  }
}

export async function authRequired(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization ?? '';
  if (!header.toLowerCase().startsWith('bearer ')) {
    reply.code(401).send({ error: 'missing_token' });
    return;
  }
  const token = header.slice(7).trim();
  if (!token) {
    reply.code(401).send({ error: 'missing_token' });
    return;
  }
  let claims: AccessClaims;
  try {
    claims = await verifyAccess(token);
  } catch {
    reply.code(401).send({ error: 'invalid_token' });
    return;
  }
  if (!(await isSessionActive(claims.sub, claims.sid))) {
    reply.code(401).send({ error: 'session_revoked' });
    return;
  }
  req.user = claims;
}
