/**
 * pricing repository — PRD §9.1/§9.2. Membership plans, discount codes,
 * per-topic pricing rules, org bulk pricing. Self-ensured (004_pricing.sql).
 */

import { query } from '../db/pg.js';

export class NotFoundError extends Error {
  constructor() { super('not_found'); this.name = 'NotFoundError'; }
}

let ensured = false;
async function ensureSchema(): Promise<void> {
  if (ensured) return;
  await query(`CREATE TABLE IF NOT EXISTS membership_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL,
    tier TEXT NOT NULL CHECK (tier IN ('basic','pro','premium')),
    price_inr NUMERIC(10,2) NOT NULL CHECK (price_inr >= 0),
    billing_period TEXT NOT NULL CHECK (billing_period IN ('monthly','annual','lifetime')),
    features JSONB NOT NULL DEFAULT '[]'::jsonb, auto_renew BOOLEAN NOT NULL DEFAULT TRUE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS discount_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), code CITEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('percentage','fixed')),
    value NUMERIC(10,2) NOT NULL CHECK (value > 0), expires_at TIMESTAMPTZ,
    usage_limit INTEGER CHECK (usage_limit IS NULL OR usage_limit > 0),
    per_user_limit INTEGER CHECK (per_user_limit IS NULL OR per_user_limit > 0),
    times_used INTEGER NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (kind <> 'percentage' OR value <= 100))`);
  await query(`CREATE TABLE IF NOT EXISTS topic_pricing_rules (
    topic_id UUID PRIMARY KEY REFERENCES content_topics(id) ON DELETE CASCADE,
    base_price_inr NUMERIC(10,2) CHECK (base_price_inr IS NULL OR base_price_inr >= 0),
    validity_days INTEGER CHECK (validity_days IS NULL OR validity_days > 0),
    early_bird_price_inr NUMERIC(10,2) CHECK (early_bird_price_inr IS NULL OR early_bird_price_inr >= 0),
    early_bird_until TIMESTAMPTZ, ppw_paise_per_min INTEGER CHECK (ppw_paise_per_min IS NULL OR ppw_paise_per_min >= 0),
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS org_topic_pricing (
    organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    topic_id UUID NOT NULL REFERENCES content_topics(id) ON DELETE CASCADE,
    price_inr NUMERIC(10,2) NOT NULL CHECK (price_inr >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (organisation_id, topic_id))`);
  ensured = true;
}

// ── Membership plans ──
export async function listPlans(): Promise<Record<string, unknown>[]> {
  await ensureSchema();
  return (await query(`SELECT * FROM membership_plans ORDER BY price_inr`)).rows;
}
export async function createPlan(i: {
  name: string; tier: string; priceInr: number; billingPeriod: string;
  features?: unknown[] | undefined; autoRenew?: boolean | undefined;
}): Promise<Record<string, unknown>> {
  await ensureSchema();
  const r = await query(
    `INSERT INTO membership_plans (name, tier, price_inr, billing_period, features, auto_renew)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6,TRUE)) RETURNING *`,
    [i.name, i.tier, i.priceInr, i.billingPeriod,
     JSON.stringify(i.features ?? []), i.autoRenew ?? null]);
  return r.rows[0]!;
}
export async function updatePlan(id: string, p: {
  name?: string | undefined; priceInr?: number | undefined;
  billingPeriod?: string | undefined; features?: unknown[] | undefined;
  autoRenew?: boolean | undefined; isActive?: boolean | undefined;
}): Promise<Record<string, unknown>> {
  await ensureSchema();
  const sets: string[] = []; const params: unknown[] = [id];
  const add = (col: string, v: unknown) => { if (v !== undefined) { params.push(v); sets.push(`${col} = $${params.length}`); } };
  add('name', p.name); add('price_inr', p.priceInr); add('billing_period', p.billingPeriod);
  add('features', p.features === undefined ? undefined : JSON.stringify(p.features));
  add('auto_renew', p.autoRenew); add('is_active', p.isActive);
  if (sets.length === 0) {
    const c = await query(`SELECT * FROM membership_plans WHERE id = $1`, [id]);
    if (!c.rows[0]) throw new NotFoundError();
    return c.rows[0];
  }
  const r = await query(
    `UPDATE membership_plans SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $1 RETURNING *`, params);
  if (!r.rows[0]) throw new NotFoundError();
  return r.rows[0];
}

// ── Discount codes ──
export async function listCodes(): Promise<Record<string, unknown>[]> {
  await ensureSchema();
  return (await query(`SELECT * FROM discount_codes ORDER BY created_at DESC`)).rows;
}
export async function createCode(i: {
  code: string; kind: string; value: number; expiresAt?: string | undefined;
  usageLimit?: number | undefined; perUserLimit?: number | undefined;
}): Promise<Record<string, unknown>> {
  await ensureSchema();
  const r = await query(
    `INSERT INTO discount_codes (code, kind, value, expires_at, usage_limit, per_user_limit)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [i.code, i.kind, i.value, i.expiresAt ?? null,
     i.usageLimit ?? null, i.perUserLimit ?? null]);
  return r.rows[0]!;
}
export async function updateCode(id: string, p: {
  value?: number | undefined; expiresAt?: string | undefined;
  usageLimit?: number | undefined; perUserLimit?: number | undefined;
  isActive?: boolean | undefined;
}): Promise<Record<string, unknown>> {
  await ensureSchema();
  const sets: string[] = []; const params: unknown[] = [id];
  const add = (col: string, v: unknown) => { if (v !== undefined) { params.push(v); sets.push(`${col} = $${params.length}`); } };
  add('value', p.value); add('expires_at', p.expiresAt); add('usage_limit', p.usageLimit);
  add('per_user_limit', p.perUserLimit); add('is_active', p.isActive);
  if (sets.length === 0) {
    const c = await query(`SELECT * FROM discount_codes WHERE id = $1`, [id]);
    if (!c.rows[0]) throw new NotFoundError();
    return c.rows[0];
  }
  const r = await query(
    `UPDATE discount_codes SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $1 RETURNING *`, params);
  if (!r.rows[0]) throw new NotFoundError();
  return r.rows[0];
}

// ── Per-topic pricing rule (upsert) ──
export async function upsertTopicPricing(topicId: string, p: {
  basePriceInr?: number | undefined; validityDays?: number | undefined;
  earlyBirdPriceInr?: number | undefined; earlyBirdUntil?: string | undefined;
  ppwPaisePerMin?: number | undefined;
}, adminId: string): Promise<Record<string, unknown>> {
  await ensureSchema();
  const t = await query(`SELECT 1 FROM content_topics WHERE id = $1`, [topicId]);
  if (!t.rows[0]) throw new NotFoundError();
  const r = await query(
    `INSERT INTO topic_pricing_rules
       (topic_id, base_price_inr, validity_days, early_bird_price_inr,
        early_bird_until, ppw_paise_per_min, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (topic_id) DO UPDATE SET
       base_price_inr = COALESCE(EXCLUDED.base_price_inr, topic_pricing_rules.base_price_inr),
       validity_days = COALESCE(EXCLUDED.validity_days, topic_pricing_rules.validity_days),
       early_bird_price_inr = COALESCE(EXCLUDED.early_bird_price_inr, topic_pricing_rules.early_bird_price_inr),
       early_bird_until = COALESCE(EXCLUDED.early_bird_until, topic_pricing_rules.early_bird_until),
       ppw_paise_per_min = COALESCE(EXCLUDED.ppw_paise_per_min, topic_pricing_rules.ppw_paise_per_min),
       updated_by = EXCLUDED.updated_by, updated_at = NOW()
     RETURNING *`,
    [topicId, p.basePriceInr ?? null, p.validityDays ?? null,
     p.earlyBirdPriceInr ?? null, p.earlyBirdUntil ?? null,
     p.ppwPaisePerMin ?? null, adminId]);
  return r.rows[0]!;
}

// ── Org bulk pricing (upsert) ──
export async function upsertOrgPricing(
  organisationId: string, topicId: string, priceInr: number,
): Promise<Record<string, unknown>> {
  await ensureSchema();
  const ok = await query(
    `SELECT (SELECT 1 FROM organisations WHERE id = $1) AS o,
            (SELECT 1 FROM content_topics WHERE id = $2) AS t`,
    [organisationId, topicId]);
  if (!ok.rows[0]?.o || !ok.rows[0]?.t) throw new NotFoundError();
  const r = await query(
    `INSERT INTO org_topic_pricing (organisation_id, topic_id, price_inr)
     VALUES ($1,$2,$3)
     ON CONFLICT (organisation_id, topic_id) DO UPDATE
       SET price_inr = EXCLUDED.price_inr, updated_at = NOW()
     RETURNING *`,
    [organisationId, topicId, priceInr]);
  return r.rows[0]!;
}
