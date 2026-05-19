/**
 * vendors repository — PRD §7.5/§7.6/§8.5. Admin vendor accounts +
 * offline batches + per-batch vendor assignment. Self-ensured.
 */

import { query } from '../db/pg.js';

export class NotFoundError extends Error {
  constructor() { super('not_found'); this.name = 'NotFoundError'; }
}

let ensured = false;
async function ensureSchema(): Promise<void> {
  if (ensured) return;
  await query(`CREATE TABLE IF NOT EXISTS vendors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL,
    contact_email CITEXT, contact_mobile TEXT,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    organisation_id UUID REFERENCES organisations(id) ON DELETE SET NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS offline_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    topic_id UUID REFERENCES content_topics(id) ON DELETE SET NULL,
    vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL,
    name TEXT NOT NULL, location TEXT, start_date DATE, end_date DATE,
    max_seats INTEGER CHECK (max_seats IS NULL OR max_seats > 0),
    hybrid_pct INTEGER NOT NULL DEFAULT 0 CHECK (hybrid_pct BETWEEN 0 AND 100),
    status TEXT NOT NULL DEFAULT 'scheduled'
      CHECK (status IN ('scheduled','active','completed','cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(`CREATE INDEX IF NOT EXISTS offline_batches_vendor_idx ON offline_batches(vendor_id)`);
  await query(`CREATE INDEX IF NOT EXISTS offline_batches_topic_idx ON offline_batches(topic_id)`);
  ensured = true;
}

function patchSql(table: string, id: string, cols: Record<string, unknown>) {
  const sets: string[] = []; const params: unknown[] = [id];
  for (const [c, v] of Object.entries(cols)) {
    if (v === undefined) continue;
    params.push(v); sets.push(`${c} = $${params.length}`);
  }
  return sets.length
    ? { sql: `UPDATE ${table} SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`, params }
    : null;
}

// ── Vendors ──
export async function listVendors(): Promise<Record<string, unknown>[]> {
  await ensureSchema();
  return (await query(`SELECT * FROM vendors ORDER BY created_at DESC`)).rows;
}
export async function createVendor(i: {
  name: string; contactEmail?: string | undefined; contactMobile?: string | undefined;
  userId?: string | undefined; organisationId?: string | undefined;
}): Promise<Record<string, unknown>> {
  await ensureSchema();
  const r = await query(
    `INSERT INTO vendors (name, contact_email, contact_mobile, user_id, organisation_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [i.name, i.contactEmail ?? null, i.contactMobile ?? null,
     i.userId ?? null, i.organisationId ?? null]);
  return r.rows[0]!;
}
export async function updateVendor(id: string, p: {
  name?: string | undefined; contactEmail?: string | undefined;
  contactMobile?: string | undefined; isActive?: boolean | undefined;
}): Promise<Record<string, unknown>> {
  await ensureSchema();
  const u = patchSql('vendors', id, {
    name: p.name, contact_email: p.contactEmail,
    contact_mobile: p.contactMobile, is_active: p.isActive,
  });
  const r = await query(u ? u.sql : `SELECT * FROM vendors WHERE id = $1`, u ? u.params : [id]);
  if (!r.rows[0]) throw new NotFoundError();
  return r.rows[0];
}

// ── Offline batches ──
export async function listBatches(vendorId?: string): Promise<Record<string, unknown>[]> {
  await ensureSchema();
  if (vendorId) {
    return (await query(
      `SELECT * FROM offline_batches WHERE vendor_id = $1 ORDER BY start_date DESC NULLS LAST`,
      [vendorId])).rows;
  }
  return (await query(
    `SELECT * FROM offline_batches ORDER BY start_date DESC NULLS LAST`)).rows;
}
export async function createBatch(i: {
  name: string; topicId?: string | undefined; vendorId?: string | undefined;
  location?: string | undefined; startDate?: string | undefined;
  endDate?: string | undefined; maxSeats?: number | undefined; hybridPct?: number | undefined;
}): Promise<Record<string, unknown>> {
  await ensureSchema();
  const r = await query(
    `INSERT INTO offline_batches
       (name, topic_id, vendor_id, location, start_date, end_date, max_seats, hybrid_pct)
     VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,0)) RETURNING *`,
    [i.name, i.topicId ?? null, i.vendorId ?? null, i.location ?? null,
     i.startDate ?? null, i.endDate ?? null, i.maxSeats ?? null, i.hybridPct ?? null]);
  return r.rows[0]!;
}
export async function updateBatch(id: string, p: {
  name?: string | undefined; location?: string | undefined;
  startDate?: string | undefined; endDate?: string | undefined;
  maxSeats?: number | undefined; hybridPct?: number | undefined;
  status?: string | undefined;
}): Promise<Record<string, unknown>> {
  await ensureSchema();
  const u = patchSql('offline_batches', id, {
    name: p.name, location: p.location, start_date: p.startDate,
    end_date: p.endDate, max_seats: p.maxSeats, hybrid_pct: p.hybridPct, status: p.status,
  });
  const r = await query(u ? u.sql : `SELECT * FROM offline_batches WHERE id = $1`, u ? u.params : [id]);
  if (!r.rows[0]) throw new NotFoundError();
  return r.rows[0];
}
export async function assignVendor(
  batchId: string, vendorId: string,
): Promise<Record<string, unknown>> {
  await ensureSchema();
  const v = await query(`SELECT 1 FROM vendors WHERE id = $1 AND is_active`, [vendorId]);
  if (!v.rows[0]) throw new NotFoundError();
  const r = await query(
    `UPDATE offline_batches SET vendor_id = $2, updated_at = NOW()
     WHERE id = $1 RETURNING *`, [batchId, vendorId]);
  if (!r.rows[0]) throw new NotFoundError();
  return r.rows[0];
}
