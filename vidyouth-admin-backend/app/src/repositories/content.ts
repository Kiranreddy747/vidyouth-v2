/**
 * content repository — the hierarchical content tree (PRD §8.2
 * FR-CONTENT-001). Owns content_sectors / _sub_sectors / _topics /
 * _subtopics / _items (003_content.sql), self-ensured like the others.
 */

import { randomBytes } from 'node:crypto';
import { query } from '../db/pg.js';

export class NotFoundError extends Error {
  constructor() { super('not_found'); this.name = 'NotFoundError'; }
}
export class MaxDepthError extends Error {
  constructor() { super('max_subtopic_depth'); this.name = 'MaxDepthError'; }
}

let ensured = false;
async function ensureSchema(): Promise<void> {
  if (ensured) return;
  await query(`CREATE TABLE IF NOT EXISTS content_sectors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL,
    slug CITEXT NOT NULL UNIQUE, icon_url TEXT, banner_url TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS content_sub_sectors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sector_id UUID NOT NULL REFERENCES content_sectors(id) ON DELETE CASCADE,
    name TEXT NOT NULL, slug CITEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (sector_id, slug))`);
  await query(`CREATE INDEX IF NOT EXISTS sub_sectors_sector_idx ON content_sub_sectors(sector_id)`);
  await query(`CREATE TABLE IF NOT EXISTS content_topics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sub_sector_id UUID NOT NULL REFERENCES content_sub_sectors(id) ON DELETE CASCADE,
    name TEXT NOT NULL, slug CITEXT NOT NULL, description TEXT,
    price_inr NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (price_inr >= 0),
    is_subscription BOOLEAN NOT NULL DEFAULT FALSE,
    validity_days INTEGER CHECK (validity_days IS NULL OR validity_days > 0),
    sort_order INTEGER NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (sub_sector_id, slug))`);
  await query(`CREATE INDEX IF NOT EXISTS topics_sub_sector_idx ON content_topics(sub_sector_id)`);
  await query(`CREATE TABLE IF NOT EXISTS content_subtopics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    topic_id UUID NOT NULL REFERENCES content_topics(id) ON DELETE CASCADE,
    parent_subtopic_id UUID REFERENCES content_subtopics(id) ON DELETE CASCADE,
    depth INTEGER NOT NULL DEFAULT 1 CHECK (depth BETWEEN 1 AND 3),
    name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(`CREATE INDEX IF NOT EXISTS subtopics_topic_idx ON content_subtopics(topic_id)`);
  await query(`CREATE INDEX IF NOT EXISTS subtopics_parent_idx ON content_subtopics(parent_subtopic_id)`);
  await query(`CREATE TABLE IF NOT EXISTS content_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    topic_id UUID REFERENCES content_topics(id) ON DELETE CASCADE,
    subtopic_id UUID REFERENCES content_subtopics(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('document','video','live_session','recorded_session','offline_training','quiz','external_link')),
    title TEXT NOT NULL, config JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_downloadable BOOLEAN NOT NULL DEFAULT FALSE, sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((topic_id IS NOT NULL) <> (subtopic_id IS NOT NULL)))`);
  await query(`CREATE INDEX IF NOT EXISTS content_items_topic_idx ON content_items(topic_id)`);
  await query(`CREATE INDEX IF NOT EXISTS content_items_subtopic_idx ON content_items(subtopic_id)`);
  ensured = true;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60)
    || 'x-' + randomBytes(3).toString('hex');
}

function buildUpdate(
  table: string,
  id: string,
  allowed: Record<string, unknown>,
): { sql: string; params: unknown[] } | null {
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const [col, val] of Object.entries(allowed)) {
    if (val === undefined) continue;
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  }
  if (sets.length === 0) return null;
  return {
    sql: `UPDATE ${table} SET ${sets.join(', ')}, updated_at = NOW()
          WHERE id = $1 RETURNING *`,
    params,
  };
}

// ─── Sectors ────────────────────────────────────────────────────────────────
export async function createSector(input: {
  name: string; iconUrl?: string | undefined; bannerUrl?: string | undefined;
  sortOrder?: number | undefined;
}): Promise<Record<string, unknown>> {
  await ensureSchema();
  const r = await query(
    `INSERT INTO content_sectors (name, slug, icon_url, banner_url, sort_order)
     VALUES ($1,$2,$3,$4,COALESCE($5,0)) RETURNING *`,
    [input.name, slugify(input.name) + '-' + randomBytes(2).toString('hex'),
     input.iconUrl ?? null, input.bannerUrl ?? null, input.sortOrder ?? null],
  );
  return r.rows[0]!;
}
export async function listSectors(): Promise<Record<string, unknown>[]> {
  await ensureSchema();
  return (await query(`SELECT * FROM content_sectors ORDER BY sort_order, name`)).rows;
}
export async function updateSector(id: string, p: {
  name?: string | undefined; iconUrl?: string | undefined;
  bannerUrl?: string | undefined; sortOrder?: number | undefined; isActive?: boolean | undefined;
}): Promise<Record<string, unknown>> {
  await ensureSchema();
  const u = buildUpdate('content_sectors', id, {
    name: p.name, icon_url: p.iconUrl, banner_url: p.bannerUrl,
    sort_order: p.sortOrder, is_active: p.isActive,
  });
  const r = await query(u ? u.sql : `SELECT * FROM content_sectors WHERE id = $1`,
    u ? u.params : [id]);
  if (!r.rows[0]) throw new NotFoundError();
  return r.rows[0];
}

// ─── Sub-sectors ────────────────────────────────────────────────────────────
export async function createSubSector(input: {
  sectorId: string; name: string; sortOrder?: number | undefined;
}): Promise<Record<string, unknown>> {
  await ensureSchema();
  const exists = await query(`SELECT 1 FROM content_sectors WHERE id = $1`, [input.sectorId]);
  if (!exists.rows[0]) throw new NotFoundError();
  const r = await query(
    `INSERT INTO content_sub_sectors (sector_id, name, slug, sort_order)
     VALUES ($1,$2,$3,COALESCE($4,0)) RETURNING *`,
    [input.sectorId, input.name, slugify(input.name), input.sortOrder ?? null],
  );
  return r.rows[0]!;
}
export async function listSubSectors(sectorId: string): Promise<Record<string, unknown>[]> {
  await ensureSchema();
  return (await query(
    `SELECT * FROM content_sub_sectors WHERE sector_id = $1 ORDER BY sort_order, name`,
    [sectorId])).rows;
}
export async function updateSubSector(id: string, p: {
  name?: string | undefined; sectorId?: string | undefined;
  sortOrder?: number | undefined; isActive?: boolean | undefined;
}): Promise<Record<string, unknown>> {
  await ensureSchema();
  const u = buildUpdate('content_sub_sectors', id, {
    name: p.name, sector_id: p.sectorId, sort_order: p.sortOrder, is_active: p.isActive,
  });
  const r = await query(u ? u.sql : `SELECT * FROM content_sub_sectors WHERE id = $1`,
    u ? u.params : [id]);
  if (!r.rows[0]) throw new NotFoundError();
  return r.rows[0];
}

// ─── Topics ─────────────────────────────────────────────────────────────────
export async function createTopic(input: {
  subSectorId: string; name: string; description?: string | undefined;
  priceInr?: number | undefined; isSubscription?: boolean | undefined;
  validityDays?: number | undefined; sortOrder?: number | undefined;
}): Promise<Record<string, unknown>> {
  await ensureSchema();
  const exists = await query(`SELECT 1 FROM content_sub_sectors WHERE id = $1`, [input.subSectorId]);
  if (!exists.rows[0]) throw new NotFoundError();
  const r = await query(
    `INSERT INTO content_topics
       (sub_sector_id, name, slug, description, price_inr, is_subscription, validity_days, sort_order)
     VALUES ($1,$2,$3,$4,COALESCE($5,0),COALESCE($6,FALSE),$7,COALESCE($8,0)) RETURNING *`,
    [input.subSectorId, input.name, slugify(input.name), input.description ?? null,
     input.priceInr ?? null, input.isSubscription ?? null,
     input.validityDays ?? null, input.sortOrder ?? null],
  );
  return r.rows[0]!;
}
export async function listTopics(subSectorId: string): Promise<Record<string, unknown>[]> {
  await ensureSchema();
  return (await query(
    `SELECT * FROM content_topics WHERE sub_sector_id = $1 ORDER BY sort_order, name`,
    [subSectorId])).rows;
}
export async function updateTopic(id: string, p: {
  name?: string | undefined; description?: string | undefined;
  priceInr?: number | undefined; isSubscription?: boolean | undefined;
  validityDays?: number | undefined; sortOrder?: number | undefined; isActive?: boolean | undefined;
}): Promise<Record<string, unknown>> {
  await ensureSchema();
  const u = buildUpdate('content_topics', id, {
    name: p.name, description: p.description, price_inr: p.priceInr,
    is_subscription: p.isSubscription, validity_days: p.validityDays,
    sort_order: p.sortOrder, is_active: p.isActive,
  });
  const r = await query(u ? u.sql : `SELECT * FROM content_topics WHERE id = $1`,
    u ? u.params : [id]);
  if (!r.rows[0]) throw new NotFoundError();
  return r.rows[0];
}

// ─── Subtopics (≤3 deep) ────────────────────────────────────────────────────
export async function createSubtopic(input: {
  topicId: string; parentSubtopicId?: string | undefined; name: string;
  sortOrder?: number | undefined;
}): Promise<Record<string, unknown>> {
  await ensureSchema();
  let depth = 1;
  let topicId = input.topicId;
  if (input.parentSubtopicId) {
    const parent = await query<{ depth: number; topic_id: string }>(
      `SELECT depth, topic_id FROM content_subtopics WHERE id = $1`,
      [input.parentSubtopicId]);
    if (!parent.rows[0]) throw new NotFoundError();
    if (parent.rows[0].depth >= 3) throw new MaxDepthError();
    depth = parent.rows[0].depth + 1;
    topicId = parent.rows[0].topic_id;
  } else {
    const t = await query(`SELECT 1 FROM content_topics WHERE id = $1`, [input.topicId]);
    if (!t.rows[0]) throw new NotFoundError();
  }
  const r = await query(
    `INSERT INTO content_subtopics
       (topic_id, parent_subtopic_id, depth, name, sort_order)
     VALUES ($1,$2,$3,$4,COALESCE($5,0)) RETURNING *`,
    [topicId, input.parentSubtopicId ?? null, depth, input.name, input.sortOrder ?? null],
  );
  return r.rows[0]!;
}
export async function listSubtopics(topicId: string): Promise<Record<string, unknown>[]> {
  await ensureSchema();
  return (await query(
    `SELECT * FROM content_subtopics WHERE topic_id = $1 ORDER BY depth, sort_order, name`,
    [topicId])).rows;
}
export async function updateSubtopic(id: string, p: {
  name?: string | undefined; sortOrder?: number | undefined; isActive?: boolean | undefined;
}): Promise<Record<string, unknown>> {
  await ensureSchema();
  const u = buildUpdate('content_subtopics', id, {
    name: p.name, sort_order: p.sortOrder, is_active: p.isActive,
  });
  const r = await query(u ? u.sql : `SELECT * FROM content_subtopics WHERE id = $1`,
    u ? u.params : [id]);
  if (!r.rows[0]) throw new NotFoundError();
  return r.rows[0];
}

// ─── Content items ──────────────────────────────────────────────────────────
const ITEM_TYPES = ['document', 'video', 'live_session', 'recorded_session',
  'offline_training', 'quiz', 'external_link'] as const;
export type ItemType = typeof ITEM_TYPES[number];

export async function createItem(input: {
  topicId?: string | undefined; subtopicId?: string | undefined;
  type: ItemType; title: string; config?: Record<string, unknown> | undefined;
  isDownloadable?: boolean | undefined; sortOrder?: number | undefined;
}): Promise<Record<string, unknown>> {
  await ensureSchema();
  if (!!input.topicId === !!input.subtopicId) {
    throw new Error('exactly_one_parent');
  }
  const r = await query(
    `INSERT INTO content_items
       (topic_id, subtopic_id, type, title, config, is_downloadable, sort_order)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6,FALSE),COALESCE($7,0)) RETURNING *`,
    [input.topicId ?? null, input.subtopicId ?? null, input.type, input.title,
     JSON.stringify(input.config ?? {}), input.isDownloadable ?? null, input.sortOrder ?? null],
  );
  return r.rows[0]!;
}
export async function listItems(
  parent: { topicId?: string | undefined; subtopicId?: string | undefined },
): Promise<Record<string, unknown>[]> {
  await ensureSchema();
  if (parent.topicId) {
    return (await query(
      `SELECT * FROM content_items WHERE topic_id = $1 ORDER BY sort_order`,
      [parent.topicId])).rows;
  }
  return (await query(
    `SELECT * FROM content_items WHERE subtopic_id = $1 ORDER BY sort_order`,
    [parent.subtopicId])).rows;
}
export async function updateItem(id: string, p: {
  title?: string | undefined; config?: Record<string, unknown> | undefined;
  isDownloadable?: boolean | undefined; sortOrder?: number | undefined; isActive?: boolean | undefined;
}): Promise<Record<string, unknown>> {
  await ensureSchema();
  const u = buildUpdate('content_items', id, {
    title: p.title,
    config: p.config === undefined ? undefined : JSON.stringify(p.config),
    is_downloadable: p.isDownloadable, sort_order: p.sortOrder, is_active: p.isActive,
  });
  const r = await query(u ? u.sql : `SELECT * FROM content_items WHERE id = $1`,
    u ? u.params : [id]);
  if (!r.rows[0]) throw new NotFoundError();
  return r.rows[0];
}

// ─── Tree (admin UI) ────────────────────────────────────────────────────────
export async function getTree(): Promise<unknown[]> {
  await ensureSchema();
  const [sectors, subs, topics] = await Promise.all([
    query(`SELECT id, name, is_active, sort_order FROM content_sectors ORDER BY sort_order, name`),
    query(`SELECT id, sector_id, name, is_active FROM content_sub_sectors ORDER BY sort_order, name`),
    query(`SELECT id, sub_sector_id, name, price_inr, is_active FROM content_topics ORDER BY sort_order, name`),
  ]);
  return sectors.rows.map((s) => ({
    ...s,
    subSectors: subs.rows
      .filter((ss) => ss.sector_id === s.id)
      .map((ss) => ({
        ...ss,
        topics: topics.rows.filter((t) => t.sub_sector_id === ss.id),
      })),
  }));
}
