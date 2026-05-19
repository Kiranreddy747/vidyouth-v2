-- 008_jobs.sql  (vidyouth-admin-backend owns the job portal admin side)
--
-- PRD §8.8 FR-JOB-001 Job Posting (Admin Side) + §7.6 Job Portal.
-- Recommendation match threshold (FR-JOB-002) lives in platform_settings
-- (key job_reco_match_pct, default 60).

CREATE TABLE IF NOT EXISTS jobs (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title                   TEXT NOT NULL,
  city                    TEXT,
  state                   TEXT,
  country                 TEXT,
  work_mode               TEXT NOT NULL DEFAULT 'on_site'
                          CHECK (work_mode IN ('remote','hybrid','on_site')),
  salary_min              NUMERIC(12,2),
  salary_max              NUMERIC(12,2),
  salary_currency         TEXT NOT NULL DEFAULT 'INR',
  is_competitive          BOOLEAN NOT NULL DEFAULT FALSE,
  exp_min_years           INTEGER CHECK (exp_min_years IS NULL OR exp_min_years >= 0),
  exp_max_years           INTEGER CHECK (exp_max_years IS NULL OR exp_max_years >= 0),
  required_skills         TEXT[] NOT NULL DEFAULT '{}',
  required_certifications TEXT[] NOT NULL DEFAULT '{}',
  description             TEXT NOT NULL,
  application_deadline    DATE,
  external_url            TEXT,
  visibility              TEXT NOT NULL DEFAULT 'public'
                          CHECK (visibility IN ('public','org_specific','premium')),
  status                  TEXT NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open','closed')),
  created_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (description IS NULL OR char_length(description) <= 5000)
);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_visibility_idx ON jobs(visibility);
