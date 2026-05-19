-- 002_org_approval.sql  (vidyouth-admin-backend owns these admin columns)
--
-- Applied against the SHARED platform database AFTER the login API's
-- migrations. Implements PRD §FR-AUTH-002 "Organisation Account
-- Registration" + §7.6 "Organisation Management": approval workflow,
-- org_code, sub-account cap, and the Super-Admin-configurable approval
-- mode (Auto-Approve | Manual Review).
--
-- The login API's 001_organisations.sql created the table with
-- status CHECK ('active','suspended','archived'). We widen it to add
-- the approval lifecycle states without disturbing existing rows.

-- 1. Widen the status domain. Constraint name is the auto-generated
--    one from 001_organisations.sql; recreate it idempotently.
ALTER TABLE organisations DROP CONSTRAINT IF EXISTS organisations_status_check;
ALTER TABLE organisations
  ADD CONSTRAINT organisations_status_check
  CHECK (status IN ('PENDING','active','REJECTED','suspended','archived'));

-- 2. Registration + approval fields (FR-AUTH-002 input + lifecycle).
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS org_code        TEXT UNIQUE;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS org_type        TEXT
  CHECK (org_type IS NULL OR org_type IN ('University','College','Corporate','NGO','Other'));
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS contact_name    TEXT;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS official_email  CITEXT;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS contact_mobile  TEXT;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS domain          TEXT;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS gst_number      TEXT;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS address         TEXT;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS sub_account_max INTEGER NOT NULL DEFAULT 50
  CHECK (sub_account_max >= 0);

-- 3. Approval audit trail (who/when, 48h SLA is measured from submitted_at).
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS submitted_at     TIMESTAMPTZ;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS approved_by      UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS approved_at      TIMESTAMPTZ;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS rejected_by      UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS rejected_at      TIMESTAMPTZ;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

CREATE INDEX IF NOT EXISTS organisations_pending_idx
  ON organisations(submitted_at) WHERE status = 'PENDING' AND deleted_at IS NULL;

-- 4. Platform settings — generic key/value for Super-Admin configuration.
--    Seeded with the org approval mode (PRD §FR-AUTH-002).
CREATE TABLE IF NOT EXISTS platform_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  description TEXT,
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO platform_settings (key, value, description) VALUES
  ('org_approval_mode', 'manual',
   'Organisation registration approval: manual (Super Admin reviews within 48h) or auto')
ON CONFLICT (key) DO NOTHING;
