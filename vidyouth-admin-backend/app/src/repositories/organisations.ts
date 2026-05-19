/**
 * organisations repository — admin approval workflow (PRD §FR-AUTH-002,
 * §7.6 Organisation Management).
 *
 * The `organisations` table is OWNED by the login API
 * (001_organisations.sql). This service only adds the approval columns
 * (002_org_approval.sql) and reads/writes the lifecycle. As with
 * feature_flags, the schema is self-ensured so the service works even
 * if 002 hasn't been applied yet.
 */

import { randomBytes } from 'node:crypto';
import { query } from '../db/pg.js';

export type OrgStatus = 'PENDING' | 'active' | 'REJECTED' | 'suspended' | 'archived';

export interface OrganisationRecord {
  id: string;
  slug: string;
  name: string;
  kind: string;
  status: OrgStatus;
  org_code: string | null;
  org_type: string | null;
  contact_name: string | null;
  official_email: string | null;
  contact_mobile: string | null;
  domain: string | null;
  gst_number: string | null;
  address: string | null;
  sub_account_max: number;
  submitted_at: Date | null;
  approved_by: string | null;
  approved_at: Date | null;
  rejected_by: string | null;
  rejected_at: Date | null;
  rejection_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `
  id, slug, name, kind, status, org_code, org_type, contact_name,
  official_email, contact_mobile, domain, gst_number, address,
  sub_account_max, submitted_at, approved_by, approved_at,
  rejected_by, rejected_at, rejection_reason, created_at, updated_at
`;

export class InvalidTransitionError extends Error {
  constructor(public readonly from: string, public readonly to: string) {
    super(`invalid_transition`);
    this.name = 'InvalidTransitionError';
  }
}

let ensured = false;

/** Mirrors database/migrations/002_org_approval.sql, idempotently. */
async function ensureSchema(): Promise<void> {
  if (ensured) return;
  await query(`ALTER TABLE organisations DROP CONSTRAINT IF EXISTS organisations_status_check`);
  await query(`
    ALTER TABLE organisations
      ADD CONSTRAINT organisations_status_check
      CHECK (status IN ('PENDING','active','REJECTED','suspended','archived'))
  `);
  const cols = [
    `org_code TEXT UNIQUE`,
    `org_type TEXT CHECK (org_type IS NULL OR org_type IN ('University','College','Corporate','NGO','Other'))`,
    `contact_name TEXT`,
    `official_email CITEXT`,
    `contact_mobile TEXT`,
    `domain TEXT`,
    `gst_number TEXT`,
    `address TEXT`,
    `sub_account_max INTEGER NOT NULL DEFAULT 50 CHECK (sub_account_max >= 0)`,
    `submitted_at TIMESTAMPTZ`,
    `approved_by UUID REFERENCES users(id) ON DELETE SET NULL`,
    `approved_at TIMESTAMPTZ`,
    `rejected_by UUID REFERENCES users(id) ON DELETE SET NULL`,
    `rejected_at TIMESTAMPTZ`,
    `rejection_reason TEXT`,
  ];
  for (const def of cols) {
    const name = def.split(' ')[0];
    await query(`ALTER TABLE organisations ADD COLUMN IF NOT EXISTS ${def}`);
    void name;
  }
  await query(`
    CREATE INDEX IF NOT EXISTS organisations_pending_idx
      ON organisations(submitted_at) WHERE status = 'PENDING' AND deleted_at IS NULL
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS platform_settings (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      description TEXT,
      updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    INSERT INTO platform_settings (key, value, description) VALUES
      ('org_approval_mode', 'manual',
       'Organisation registration approval: manual (Super Admin reviews within 48h) or auto')
    ON CONFLICT (key) DO NOTHING
  `);
  ensured = true;
}

async function generateOrgCode(): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const code = 'VY-' + randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
    const taken = await query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM organisations WHERE org_code = $1) AS exists`,
      [code],
    );
    if (!taken.rows[0]?.exists) return code;
  }
  // Fallback that cannot realistically collide.
  return 'VY-' + randomBytes(6).toString('hex').toUpperCase();
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 48) || 'org';
}

async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  for (let i = 0; i < 8; i++) {
    const candidate = i === 0 ? base : `${base}-${i}`;
    const taken = await query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM organisations WHERE slug = $1) AS exists`,
      [candidate],
    );
    if (!taken.rows[0]?.exists) return candidate;
  }
  return `${base}-${randomBytes(3).toString('hex')}`;
}

export interface ListOrgFilter {
  status?: OrgStatus | undefined;
  limit: number;
  offset: number;
}

export async function listOrganisations(
  filter: ListOrgFilter,
): Promise<{ total: number; organisations: OrganisationRecord[] }> {
  await ensureSchema();
  const where = filter.status ? `WHERE deleted_at IS NULL AND status = $3` : `WHERE deleted_at IS NULL`;
  const params: unknown[] = filter.status
    ? [filter.limit, filter.offset, filter.status]
    : [filter.limit, filter.offset];
  const [rows, count] = await Promise.all([
    query<OrganisationRecord>(
      `SELECT ${COLUMNS} FROM organisations ${where}
       ORDER BY (status = 'PENDING') DESC, submitted_at ASC NULLS LAST, created_at DESC
       LIMIT $1 OFFSET $2`,
      params,
    ),
    query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM organisations ${filter.status ? `WHERE deleted_at IS NULL AND status = $1` : `WHERE deleted_at IS NULL`}`,
      filter.status ? [filter.status] : [],
    ),
  ]);
  return { total: Number(count.rows[0]?.n ?? 0), organisations: rows.rows };
}

export async function getOrganisation(id: string): Promise<OrganisationRecord | null> {
  await ensureSchema();
  const r = await query<OrganisationRecord>(
    `SELECT ${COLUMNS} FROM organisations WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
    [id],
  );
  return r.rows[0] ?? null;
}

async function requireStatus(id: string, expected: OrgStatus[]): Promise<OrganisationRecord> {
  const org = await getOrganisation(id);
  if (!org) throw new InvalidTransitionError('missing', 'n/a');
  if (!expected.includes(org.status)) throw new InvalidTransitionError(org.status, expected.join('|'));
  return org;
}

export async function approveOrganisation(
  id: string,
  adminId: string,
): Promise<OrganisationRecord | null> {
  await ensureSchema();
  const existing = await getOrganisation(id);
  if (!existing) return null;
  await requireStatus(id, ['PENDING']);
  const code = existing.org_code ?? (await generateOrgCode());
  const r = await query<OrganisationRecord>(
    `UPDATE organisations
       SET status = 'active', org_code = $2, approved_by = $3,
           approved_at = NOW(), rejected_by = NULL, rejected_at = NULL,
           rejection_reason = NULL, updated_at = NOW()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, code, adminId],
  );
  return r.rows[0] ?? null;
}

export async function rejectOrganisation(
  id: string,
  adminId: string,
  reason: string,
): Promise<OrganisationRecord | null> {
  await ensureSchema();
  const existing = await getOrganisation(id);
  if (!existing) return null;
  await requireStatus(id, ['PENDING']);
  const r = await query<OrganisationRecord>(
    `UPDATE organisations
       SET status = 'REJECTED', rejected_by = $3, rejected_at = NOW(),
           rejection_reason = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, reason, adminId],
  );
  return r.rows[0] ?? null;
}

export async function suspendOrganisation(
  id: string,
  adminId: string,
): Promise<OrganisationRecord | null> {
  await ensureSchema();
  const existing = await getOrganisation(id);
  if (!existing) return null;
  await requireStatus(id, ['active']);
  const r = await query<OrganisationRecord>(
    `UPDATE organisations
       SET status = 'suspended', updated_at = NOW()
     WHERE id = $1 RETURNING ${COLUMNS}`,
    [id],
  );
  void adminId;
  return r.rows[0] ?? null;
}

export async function reactivateOrganisation(
  id: string,
  adminId: string,
): Promise<OrganisationRecord | null> {
  await ensureSchema();
  const existing = await getOrganisation(id);
  if (!existing) return null;
  await requireStatus(id, ['suspended']);
  const r = await query<OrganisationRecord>(
    `UPDATE organisations
       SET status = 'active', updated_at = NOW()
     WHERE id = $1 RETURNING ${COLUMNS}`,
    [id],
  );
  void adminId;
  return r.rows[0] ?? null;
}

export interface CreateOrgInput {
  name: string;
  kind: string;
  orgType?: string | undefined;
  contactName?: string | undefined;
  officialEmail?: string | undefined;
  contactMobile?: string | undefined;
  domain?: string | undefined;
  gstNumber?: string | undefined;
  address?: string | undefined;
  subAccountMax?: number | undefined;
}

/** Admin-created org — skips approval, active immediately (PRD §7.6). */
export async function createOrganisation(
  input: CreateOrgInput,
  adminId: string,
): Promise<OrganisationRecord> {
  await ensureSchema();
  const slug = await uniqueSlug(input.name);
  const code = await generateOrgCode();
  const r = await query<OrganisationRecord>(
    `INSERT INTO organisations
       (slug, name, kind, status, org_code, org_type, contact_name,
        official_email, contact_mobile, domain, gst_number, address,
        sub_account_max, approved_by, approved_at)
     VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9,$10,$11,
             COALESCE($12, 50), $13, NOW())
     RETURNING ${COLUMNS}`,
    [
      slug,
      input.name,
      input.kind,
      code,
      input.orgType ?? null,
      input.contactName ?? null,
      input.officialEmail ?? null,
      input.contactMobile ?? null,
      input.domain ?? null,
      input.gstNumber ?? null,
      input.address ?? null,
      input.subAccountMax ?? null,
      adminId,
    ],
  );
  return r.rows[0]!;
}

export type ApprovalMode = 'manual' | 'auto';

export async function getApprovalMode(): Promise<ApprovalMode> {
  await ensureSchema();
  const r = await query<{ value: string }>(
    `SELECT value FROM platform_settings WHERE key = 'org_approval_mode' LIMIT 1`,
  );
  return (r.rows[0]?.value as ApprovalMode) ?? 'manual';
}

export async function setApprovalMode(
  mode: ApprovalMode,
  adminId: string,
): Promise<ApprovalMode> {
  await ensureSchema();
  await query(
    `INSERT INTO platform_settings (key, value, updated_by, updated_at)
     VALUES ('org_approval_mode', $1, $2, NOW())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [mode, adminId],
  );
  return mode;
}
