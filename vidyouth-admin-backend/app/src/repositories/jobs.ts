/**
 * jobs repository — PRD §8.8 FR-JOB-001/002 + §7.6 Job Portal.
 * Admin posts/edits/closes jobs and configures the recommendation
 * match threshold. Self-ensured (008_jobs.sql).
 */

import { query } from '../db/pg.js';

export class NotFoundError extends Error {
  constructor() { super('not_found'); this.name = 'NotFoundError'; }
}

let ensured = false;
async function ensureSchema(): Promise<void> {
  if (ensured) return;
  await query(`CREATE TABLE IF NOT EXISTS platform_settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, description TEXT,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), title TEXT NOT NULL,
    city TEXT, state TEXT, country TEXT,
    work_mode TEXT NOT NULL DEFAULT 'on_site' CHECK (work_mode IN ('remote','hybrid','on_site')),
    salary_min NUMERIC(12,2), salary_max NUMERIC(12,2),
    salary_currency TEXT NOT NULL DEFAULT 'INR', is_competitive BOOLEAN NOT NULL DEFAULT FALSE,
    exp_min_years INTEGER CHECK (exp_min_years IS NULL OR exp_min_years >= 0),
    exp_max_years INTEGER CHECK (exp_max_years IS NULL OR exp_max_years >= 0),
    required_skills TEXT[] NOT NULL DEFAULT '{}',
    required_certifications TEXT[] NOT NULL DEFAULT '{}',
    description TEXT NOT NULL, application_deadline DATE, external_url TEXT,
    visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','org_specific','premium')),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (description IS NULL OR char_length(description) <= 5000))`);
  await query(`CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status, created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS jobs_visibility_idx ON jobs(visibility)`);
  ensured = true;
}

export async function listJobs(f: {
  status?: string | undefined; visibility?: string | undefined;
  limit: number; offset: number;
}): Promise<{ total: number; jobs: Record<string, unknown>[] }> {
  await ensureSchema();
  const cl: string[] = []; const params: unknown[] = [];
  if (f.status) { params.push(f.status); cl.push(`status = $${params.length}`); }
  if (f.visibility) { params.push(f.visibility); cl.push(`visibility = $${params.length}`); }
  const where = cl.length ? `WHERE ${cl.join(' AND ')}` : '';
  const [rows, count] = await Promise.all([
    query(`SELECT * FROM jobs ${where} ORDER BY created_at DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, f.limit, f.offset]),
    query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM jobs ${where}`, params),
  ]);
  return { total: Number(count.rows[0]?.n ?? 0), jobs: rows.rows };
}

export async function getJob(id: string): Promise<Record<string, unknown> | null> {
  await ensureSchema();
  return (await query(`SELECT * FROM jobs WHERE id = $1`, [id])).rows[0] ?? null;
}

export interface JobInput {
  title: string; city?: string | undefined; state?: string | undefined;
  country?: string | undefined; workMode?: string | undefined;
  salaryMin?: number | undefined; salaryMax?: number | undefined;
  salaryCurrency?: string | undefined; isCompetitive?: boolean | undefined;
  expMinYears?: number | undefined; expMaxYears?: number | undefined;
  requiredSkills?: string[] | undefined; requiredCertifications?: string[] | undefined;
  description: string; applicationDeadline?: string | undefined;
  externalUrl?: string | undefined; visibility?: string | undefined;
}

export async function createJob(i: JobInput, adminId: string): Promise<Record<string, unknown>> {
  await ensureSchema();
  const r = await query(
    `INSERT INTO jobs
       (title, city, state, country, work_mode, salary_min, salary_max,
        salary_currency, is_competitive, exp_min_years, exp_max_years,
        required_skills, required_certifications, description,
        application_deadline, external_url, visibility, created_by)
     VALUES ($1,$2,$3,$4,COALESCE($5,'on_site'),$6,$7,COALESCE($8,'INR'),
             COALESCE($9,FALSE),$10,$11,$12::text[],$13::text[],$14,$15,$16,
             COALESCE($17,'public'),$18)
     RETURNING *`,
    [i.title, i.city ?? null, i.state ?? null, i.country ?? null, i.workMode ?? null,
     i.salaryMin ?? null, i.salaryMax ?? null, i.salaryCurrency ?? null,
     i.isCompetitive ?? null, i.expMinYears ?? null, i.expMaxYears ?? null,
     i.requiredSkills ?? [], i.requiredCertifications ?? [], i.description,
     i.applicationDeadline ?? null, i.externalUrl ?? null, i.visibility ?? null, adminId]);
  return r.rows[0]!;
}

export type JobPatch =
  { [K in keyof JobInput]?: JobInput[K] | undefined } & { status?: string | undefined };

export async function updateJob(
  id: string, p: JobPatch,
): Promise<Record<string, unknown>> {
  await ensureSchema();
  const map: Record<string, unknown> = {
    title: p.title, city: p.city, state: p.state, country: p.country,
    work_mode: p.workMode, salary_min: p.salaryMin, salary_max: p.salaryMax,
    salary_currency: p.salaryCurrency, is_competitive: p.isCompetitive,
    exp_min_years: p.expMinYears, exp_max_years: p.expMaxYears,
    required_skills: p.requiredSkills, required_certifications: p.requiredCertifications,
    description: p.description, application_deadline: p.applicationDeadline,
    external_url: p.externalUrl, visibility: p.visibility, status: p.status,
  };
  const sets: string[] = []; const params: unknown[] = [id];
  for (const [c, v] of Object.entries(map)) {
    if (v === undefined) continue;
    params.push(v);
    sets.push(c.endsWith('skills') || c.endsWith('certifications')
      ? `${c} = $${params.length}::text[]` : `${c} = $${params.length}`);
  }
  const r = await query(
    sets.length
      ? `UPDATE jobs SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`
      : `SELECT * FROM jobs WHERE id = $1`,
    sets.length ? params : [id]);
  if (!r.rows[0]) throw new NotFoundError();
  return r.rows[0];
}

export async function getRecoConfig(): Promise<{ matchPct: number }> {
  await ensureSchema();
  const r = await query<{ value: string }>(
    `SELECT value FROM platform_settings WHERE key = 'job_reco_match_pct'`);
  return { matchPct: r.rows[0] ? Number(r.rows[0].value) : 60 };
}
export async function setRecoConfig(matchPct: number, adminId: string): Promise<{ matchPct: number }> {
  await ensureSchema();
  await query(
    `INSERT INTO platform_settings (key, value, updated_by, updated_at)
     VALUES ('job_reco_match_pct', $1, $2, NOW())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [String(matchPct), adminId]);
  return { matchPct };
}
