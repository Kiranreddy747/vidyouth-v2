/**
 * Audit writer — same audit_events table as the login API (shared DB),
 * so all platform events live in one tamper-evident log.
 */

import { query } from '../db/pg.js';

export type AuditAction =
  | 'admin.access'
  | 'admin.access.denied'
  | 'admin.feature_flag.changed'
  | 'org.created'
  | 'org.approved'
  | 'org.rejected'
  | 'org.suspended'
  | 'org.reactivated'
  | 'admin.setting.changed'
  | 'user.updated'
  | 'user.deactivated'
  | 'user.reactivated'
  | 'user.force_logout'
  | 'user.unlocked'
  | 'user.password_reset_issued'
  | 'user.impersonate_attempt'
  | 'content.created'
  | 'content.updated'
  | 'pricing.changed'
  | 'payment.refunded'
  | 'wallet.adjusted'
  | 'payment.config.changed'
  | 'cert.template.changed'
  | 'cert.rule.changed'
  | 'cert.issued'
  | 'cert.revoked'
  | 'vendor.created'
  | 'vendor.updated'
  | 'batch.created'
  | 'batch.updated'
  | 'batch.vendor_assigned'
  | 'job.created'
  | 'job.updated'
  | 'job.reco_config_changed'
  | 'notification.template.changed';

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
