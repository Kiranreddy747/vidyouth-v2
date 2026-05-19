/**
 * Audit log writer. Writes events synchronously to Postgres
 * (audit_events) for query/online use, and is intended to feed an S3
 * archive via a downstream job (Firehose / batch unloader) so the
 * tamper-evident long-term audit copy lives outside the app's RDS instance.
 */

import { query } from '../db/pg.js';

export type AuditAction =
  | 'login.success'
  | 'login.failed'
  | 'login.locked'
  | 'login.unlocked'
  | 'otp.requested'
  | 'otp.verified'
  | 'otp.failed'
  | 'session.evicted'
  | 'session.refreshed'
  | 'session.logout'
  | 'password.changed'
  | 'account.created'
  | 'role.changed'
  // Email verification (introduced by PR #2 / kmzpzssrj67)
  | 'email.verified'
  | 'email.verification.requested'
  | 'email.verification.failed'
  // Password reset flow (PR #2)
  | 'password.reset.requested'
  | 'password.reset.completed'
  | 'password.reset.failed'
  // Phone OTP (PR #3 / Jagadheesh)
  | 'phone.otp.requested'
  | 'phone.otp.verified'
  | 'phone.otp.failed'
  // OAuth MFA
  | 'oauth.mfa.requested'
  | 'oauth.mfa.verified'
  | 'oauth.mfa.failed';

export interface AuditEvent {
  userId?: string | undefined;
  organisationId?: string | undefined;
  action: AuditAction;
  ip?: string | undefined;
  userAgent?: string | undefined;
  meta?: Record<string, unknown> | undefined;
  succeeded: boolean;
}

export async function recordAudit(event: AuditEvent): Promise<void> {
  await query(
    `INSERT INTO audit_events
       (user_id, organisation_id, action, ip, user_agent, meta, succeeded, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
    [
      event.userId ?? null,
      event.organisationId ?? null,
      event.action,
      event.ip ?? null,
      event.userAgent ?? null,
      event.meta ? JSON.stringify(event.meta) : null,
      event.succeeded,
    ],
  );
}
