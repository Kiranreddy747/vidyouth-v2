/**
 * Redis client — shares the platform Redis with the login API so the
 * session-active / force-logout check (PRD §FR-AUTH-003: "Super Admin
 * can remotely invalidate all sessions") is honoured by the admin panel
 * too: a logged-out / revoked token must not reach /admin/*.
 *
 * Session set key convention (must match the login API):
 *   sess:{userId}  → ZSET of active sessionId
 */

import Redis from 'ioredis';
import { env } from '../config/env.js';

export const redis = new Redis(env.REDIS_URL, {
  keyPrefix: env.REDIS_KEY_PREFIX,
  lazyConnect: env.NODE_ENV === 'test',
  enableReadyCheck: true,
  maxRetriesPerRequest: 3,
});

redis.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error({ err: err.message }, 'redis error');
});

/** True if (userId, sessionId) is still an active session — same check
 *  the login API uses, so logout / eviction invalidates admin access too. */
export async function isSessionActive(userId: string, sessionId: string): Promise<boolean> {
  const score = await redis.zscore(`sess:${userId}`, sessionId);
  return score !== null;
}

export async function pingRedis(): Promise<boolean> {
  try {
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  await redis.quit();
}
