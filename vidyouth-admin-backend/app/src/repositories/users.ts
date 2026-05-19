/**
 * users repository — admin User Management (PRD §7.6 User Management,
 * §FR-AUTH-003 Force Logout / manual unlock).
 *
 * users / sessions / password_reset_tokens are OWNED by the login API.
 * This module only reads/operates on them and mirrors the login API's
 * exact Redis conventions so admin actions take real effect:
 *   sess:{userId}  ZSET of active sessionId   (force logout)
 *   fail:{userId}  failed-login counter       (unlock)
 *   lock:{userId}  lock flag                   (unlock)
 */

import { createHash, randomBytes } from 'node:crypto';
import { query } from '../db/pg.js';
import { redis } from '../db/redis.js';
import { env } from '../config/env.js';

export interface UserRecord {
  id: string;
  email: string | null;
  mobile: string | null;
  role: string;
  display_name: string | null;
  organisation_id: string | null;
  is_active: boolean;
  email_verified_at: Date | null;
  mobile_verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `
  id, email, mobile, role, display_name, organisation_id, is_active,
  email_verified_at, mobile_verified_at, created_at, updated_at
`;

export interface ListUserFilter {
  q?: string | undefined;
  role?: string | undefined;
  active?: boolean | undefined;
  limit: number;
  offset: number;
}

export async function listUsers(
  f: ListUserFilter,
): Promise<{ total: number; users: UserRecord[] }> {
  const clauses: string[] = ['deleted_at IS NULL'];
  const params: unknown[] = [];
  if (f.q) {
    params.push(`%${f.q}%`);
    clauses.push(
      `(email ILIKE $${params.length} OR mobile ILIKE $${params.length} OR display_name ILIKE $${params.length})`,
    );
  }
  if (f.role) {
    params.push(f.role);
    clauses.push(`role = $${params.length}`);
  }
  if (typeof f.active === 'boolean') {
    params.push(f.active);
    clauses.push(`is_active = $${params.length}`);
  }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const limitIdx = params.length + 1;
  const offsetIdx = params.length + 2;

  const [rows, count] = await Promise.all([
    query<UserRecord>(
      `SELECT ${COLUMNS} FROM users ${where}
       ORDER BY created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...params, f.limit, f.offset],
    ),
    query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM users ${where}`, params),
  ]);
  return { total: Number(count.rows[0]?.n ?? 0), users: rows.rows };
}

async function isLocked(userId: string): Promise<boolean> {
  return (await redis.get(`lock:${userId}`)) !== null;
}

export interface UserDetail extends UserRecord {
  active_session_count: number;
  locked: boolean;
}

export async function getUser(id: string): Promise<UserDetail | null> {
  const r = await query<UserRecord>(
    `SELECT ${COLUMNS} FROM users WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
    [id],
  );
  const u = r.rows[0];
  if (!u) return null;
  const sessions = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`,
    [id],
  );
  return {
    ...u,
    active_session_count: Number(sessions.rows[0]?.n ?? 0),
    locked: await isLocked(id),
  };
}

export interface UpdateUserInput {
  displayName?: string | undefined;
  role?: string | undefined;
  isActive?: boolean | undefined;
}

export async function updateUser(
  id: string,
  patch: UpdateUserInput,
): Promise<UserRecord | null> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  if (patch.displayName !== undefined) {
    params.push(patch.displayName);
    sets.push(`display_name = $${params.length}`);
  }
  if (patch.role !== undefined) {
    params.push(patch.role);
    sets.push(`role = $${params.length}`);
  }
  if (patch.isActive !== undefined) {
    params.push(patch.isActive);
    sets.push(`is_active = $${params.length}`);
  }
  if (sets.length === 0) {
    const cur = await query<UserRecord>(
      `SELECT ${COLUMNS} FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return cur.rows[0] ?? null;
  }
  const r = await query<UserRecord>(
    `UPDATE users SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING ${COLUMNS}`,
    params,
  );
  return r.rows[0] ?? null;
}

/** PRD §FR-AUTH-003: invalidate ALL sessions for a user. Mirrors the
 *  login API's endAllSessions exactly (Redis set + DB revocation). */
export async function forceLogout(
  userId: string,
  reason = 'admin_forced',
): Promise<{ revoked: number } | null> {
  const exists = await query<{ id: string }>(
    `SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  if (!exists.rows[0]) return null;
  await redis.del(`sess:${userId}`);
  const r = await query(
    `UPDATE sessions SET revoked_at = NOW(), revoked_reason = $2
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, reason],
  );
  return { revoked: r.rowCount ?? 0 };
}

export async function deactivateUser(userId: string): Promise<UserRecord | null> {
  const r = await query<UserRecord>(
    `UPDATE users SET is_active = FALSE, updated_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL RETURNING ${COLUMNS}`,
    [userId],
  );
  if (!r.rows[0]) return null;
  await forceLogout(userId, 'admin_deactivated');
  return r.rows[0];
}

export async function reactivateUser(userId: string): Promise<UserRecord | null> {
  const r = await query<UserRecord>(
    `UPDATE users SET is_active = TRUE, updated_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL RETURNING ${COLUMNS}`,
    [userId],
  );
  return r.rows[0] ?? null;
}

/** PRD §FR-AUTH-003: "Admin can unlock manually." Mirrors resetFailures. */
export async function unlockUser(userId: string): Promise<boolean> {
  const exists = await query<{ id: string }>(
    `SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  if (!exists.rows[0]) return false;
  await redis.del(`fail:${userId}`, `lock:${userId}`);
  return true;
}

function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Admin-initiated password reset. Creates a login-API-compatible
 *  password_reset_tokens row (same sha256 scheme) and returns the link
 *  for the admin to relay. We never set a password directly. */
export async function issuePasswordReset(
  userId: string,
): Promise<{ resetUrl: string; expiresAt: Date } | null> {
  const u = await query<{ id: string }>(
    `SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  if (!u.rows[0]) return null;

  // Invalidate any outstanding tokens (mirrors revokeUserResetTokens).
  await query(
    `UPDATE password_reset_tokens SET consumed_at = NOW()
     WHERE user_id = $1 AND consumed_at IS NULL`,
    [userId],
  );

  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = hashResetToken(rawToken);
  const expiresAt = new Date(Date.now() + env.PASSWORD_RESET_TTL_SECONDS * 1000);

  await query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt],
  );

  const base = env.APP_BASE_URL.replace(/\/+$/, '');
  return {
    resetUrl: `${base}/reset-password?token=${encodeURIComponent(rawToken)}`,
    expiresAt,
  };
}
