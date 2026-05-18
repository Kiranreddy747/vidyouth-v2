-- 001_feature_flags.sql  (vidyouth-admin-backend owns this table)
--
-- Applied against the SHARED platform database AFTER the login API's
-- migrations (it FKs users.id). PRD §10.2 "Feature Toggles": Super Admin
-- switches these platform-wide WITHOUT a code change, so they are
-- persisted + auditable.

CREATE TABLE IF NOT EXISTS feature_flags (
  key          TEXT PRIMARY KEY,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  label        TEXT NOT NULL,
  description  TEXT,
  updated_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO feature_flags (key, enabled, label, description) VALUES
  ('wallet_module',          TRUE,  'Wallet Module',                 'When OFF, wallet UI hidden and wallet payment option removed'),
  ('pay_per_watch',          TRUE,  'Pay-Per-Watch',                 'When OFF, all content defaults to subscription / one-time pricing'),
  ('placement_support',      TRUE,  'Placement Support',             'When OFF, placement request UI hidden'),
  ('social_auto_publishing', TRUE,  'Social Auto-Publishing',        'When OFF, news posts are in-app only'),
  ('org_self_registration',  TRUE,  'Organisation Self-Registration','When OFF, orgs are only created by Admin'),
  ('job_portal',             TRUE,  'Job Portal',                    'When OFF, hidden from all dashboards'),
  ('resume_builder',         TRUE,  'Resume Builder',                'When OFF, hidden from profiles'),
  ('lms_module',             TRUE,  'LMS Module',                    'When OFF, LMS section hidden; existing enrolments still accessible'),
  ('content_live',           TRUE,  'Live Content',                  'Hide live content type platform-wide'),
  ('content_recorded',       TRUE,  'Recorded Content',              'Hide recorded content type platform-wide'),
  ('content_offline',        TRUE,  'Offline Content',               'Hide offline content type platform-wide')
ON CONFLICT (key) DO NOTHING;

CREATE INDEX IF NOT EXISTS feature_flags_enabled_idx ON feature_flags(enabled);
