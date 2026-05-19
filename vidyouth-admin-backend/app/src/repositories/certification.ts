/**
 * certification repository — PRD §8.6 / §7.6. Admin configures templates
 * + per-topic issuance rules and manually issues / revokes certificates.
 * Self-ensured (006_certification.sql).
 */

import { query } from '../db/pg.js';

export class NotFoundError extends Error {
  constructor() { super('not_found'); this.name = 'NotFoundError'; }
}
export class InvalidStateError extends Error {
  constructor(public reason: string) { super(reason); this.name = 'InvalidStateError'; }
}

let ensured = false;
async function ensureSchema(): Promise<void> {
  if (ensured) return;
  await query(`CREATE TABLE IF NOT EXISTS certificate_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL,
    config JSONB NOT NULL DEFAULT '{}'::jsonb, is_default BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS certification_rules (
    topic_id UUID PRIMARY KEY REFERENCES content_topics(id) ON DELETE CASCADE,
    min_completion_pct INTEGER NOT NULL DEFAULT 80 CHECK (min_completion_pct BETWEEN 0 AND 100),
    min_assessment_pct INTEGER NOT NULL DEFAULT 70 CHECK (min_assessment_pct BETWEEN 0 AND 100),
    requires_offline BOOLEAN NOT NULL DEFAULT FALSE,
    expiry_mode TEXT NOT NULL DEFAULT 'lifetime' CHECK (expiry_mode IN ('lifetime','expiry')),
    validity_days INTEGER CHECK (validity_days IS NULL OR validity_days > 0),
    template_id UUID REFERENCES certificate_templates(id) ON DELETE SET NULL,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS certificates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cert_uuid UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    topic_id UUID REFERENCES content_topics(id) ON DELETE SET NULL,
    learner_name TEXT NOT NULL, course_name TEXT NOT NULL,
    template_id UUID REFERENCES certificate_templates(id) ON DELETE SET NULL,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
    revoked_at TIMESTAMPTZ, revoked_by UUID REFERENCES users(id) ON DELETE SET NULL,
    revoked_reason TEXT)`);
  await query(`CREATE INDEX IF NOT EXISTS certificates_user_idx ON certificates(user_id)`);
  await query(`CREATE INDEX IF NOT EXISTS certificates_status_idx ON certificates(status, issued_at DESC)`);
  ensured = true;
}

// ── Templates ──
export async function listTemplates(): Promise<Record<string, unknown>[]> {
  await ensureSchema();
  return (await query(`SELECT * FROM certificate_templates ORDER BY created_at DESC`)).rows;
}
export async function createTemplate(i: {
  name: string; config?: Record<string, unknown> | undefined; isDefault?: boolean | undefined;
}): Promise<Record<string, unknown>> {
  await ensureSchema();
  const r = await query(
    `INSERT INTO certificate_templates (name, config, is_default)
     VALUES ($1,$2,COALESCE($3,FALSE)) RETURNING *`,
    [i.name, JSON.stringify(i.config ?? {}), i.isDefault ?? null]);
  return r.rows[0]!;
}
export async function updateTemplate(id: string, p: {
  name?: string | undefined; config?: Record<string, unknown> | undefined;
  isDefault?: boolean | undefined; isActive?: boolean | undefined;
}): Promise<Record<string, unknown>> {
  await ensureSchema();
  const sets: string[] = []; const params: unknown[] = [id];
  const add = (c: string, v: unknown) => { if (v !== undefined) { params.push(v); sets.push(`${c} = $${params.length}`); } };
  add('name', p.name);
  add('config', p.config === undefined ? undefined : JSON.stringify(p.config));
  add('is_default', p.isDefault); add('is_active', p.isActive);
  if (sets.length === 0) {
    const c = await query(`SELECT * FROM certificate_templates WHERE id = $1`, [id]);
    if (!c.rows[0]) throw new NotFoundError();
    return c.rows[0];
  }
  const r = await query(
    `UPDATE certificate_templates SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $1 RETURNING *`, params);
  if (!r.rows[0]) throw new NotFoundError();
  return r.rows[0];
}

// ── Per-topic issuance rule (upsert) ──
export async function getRule(topicId: string): Promise<Record<string, unknown> | null> {
  await ensureSchema();
  return (await query(`SELECT * FROM certification_rules WHERE topic_id = $1`, [topicId])).rows[0] ?? null;
}
export async function upsertRule(topicId: string, p: {
  minCompletionPct?: number | undefined; minAssessmentPct?: number | undefined;
  requiresOffline?: boolean | undefined; expiryMode?: string | undefined;
  validityDays?: number | undefined; templateId?: string | undefined;
}, adminId: string): Promise<Record<string, unknown>> {
  await ensureSchema();
  const t = await query(`SELECT 1 FROM content_topics WHERE id = $1`, [topicId]);
  if (!t.rows[0]) throw new NotFoundError();
  const r = await query(
    `INSERT INTO certification_rules
       (topic_id, min_completion_pct, min_assessment_pct, requires_offline,
        expiry_mode, validity_days, template_id, updated_by)
     VALUES ($1, COALESCE($2,80), COALESCE($3,70), COALESCE($4,FALSE),
             COALESCE($5,'lifetime'), $6, $7, $8)
     ON CONFLICT (topic_id) DO UPDATE SET
       min_completion_pct = COALESCE(EXCLUDED.min_completion_pct, certification_rules.min_completion_pct),
       min_assessment_pct = COALESCE(EXCLUDED.min_assessment_pct, certification_rules.min_assessment_pct),
       requires_offline   = COALESCE(EXCLUDED.requires_offline, certification_rules.requires_offline),
       expiry_mode        = COALESCE(EXCLUDED.expiry_mode, certification_rules.expiry_mode),
       validity_days      = COALESCE(EXCLUDED.validity_days, certification_rules.validity_days),
       template_id        = COALESCE(EXCLUDED.template_id, certification_rules.template_id),
       updated_by = EXCLUDED.updated_by, updated_at = NOW()
     RETURNING *`,
    [topicId, p.minCompletionPct ?? null, p.minAssessmentPct ?? null,
     p.requiresOffline ?? null, p.expiryMode ?? null, p.validityDays ?? null,
     p.templateId ?? null, adminId]);
  return r.rows[0]!;
}

// ── Certificates (manual issue / revoke / list) ──
export async function listCertificates(f: {
  userId?: string | undefined; topicId?: string | undefined;
  status?: string | undefined; limit: number; offset: number;
}): Promise<{ total: number; certificates: Record<string, unknown>[] }> {
  await ensureSchema();
  const cl: string[] = []; const params: unknown[] = [];
  if (f.userId) { params.push(f.userId); cl.push(`user_id = $${params.length}`); }
  if (f.topicId) { params.push(f.topicId); cl.push(`topic_id = $${params.length}`); }
  if (f.status) { params.push(f.status); cl.push(`status = $${params.length}`); }
  const where = cl.length ? `WHERE ${cl.join(' AND ')}` : '';
  const [rows, count] = await Promise.all([
    query(`SELECT * FROM certificates ${where} ORDER BY issued_at DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, f.limit, f.offset]),
    query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM certificates ${where}`, params),
  ]);
  return { total: Number(count.rows[0]?.n ?? 0), certificates: rows.rows };
}

export async function issueCertificate(
  userId: string, topicId: string,
): Promise<Record<string, unknown>> {
  await ensureSchema();
  const u = await query<{ display_name: string | null; email: string | null }>(
    `SELECT display_name, email FROM users WHERE id = $1 AND deleted_at IS NULL`, [userId]);
  if (!u.rows[0]) throw new NotFoundError();
  const t = await query<{ name: string }>(
    `SELECT name FROM content_topics WHERE id = $1`, [topicId]);
  if (!t.rows[0]) throw new NotFoundError();

  const rule = await query<{
    expiry_mode: string; validity_days: number | null; template_id: string | null;
  }>(`SELECT expiry_mode, validity_days, template_id FROM certification_rules WHERE topic_id = $1`,
    [topicId]);
  const rr = rule.rows[0];
  const expiresAt = rr && rr.expiry_mode === 'expiry' && rr.validity_days
    ? new Date(Date.now() + rr.validity_days * 86_400_000) : null;

  const r = await query(
    `INSERT INTO certificates
       (user_id, topic_id, learner_name, course_name, template_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [userId, topicId, u.rows[0].display_name ?? u.rows[0].email ?? 'Learner',
     t.rows[0].name, rr?.template_id ?? null, expiresAt]);
  return r.rows[0]!;
}

export async function revokeCertificate(
  id: string, adminId: string, reason: string,
): Promise<Record<string, unknown>> {
  await ensureSchema();
  const c = await query<{ status: string }>(
    `SELECT status FROM certificates WHERE id = $1`, [id]);
  if (!c.rows[0]) throw new NotFoundError();
  if (c.rows[0].status === 'revoked') throw new InvalidStateError('already_revoked');
  const r = await query(
    `UPDATE certificates
       SET status = 'revoked', revoked_at = NOW(), revoked_by = $2, revoked_reason = $3
     WHERE id = $1 RETURNING *`, [id, adminId, reason]);
  return r.rows[0]!;
}
