-- 006_certification.sql  (vidyouth-admin-backend owns cert config)
--
-- PRD §8.6 FR-CERT-001 + §7.6 Certification Engine. Admin configures
-- templates + per-topic issuance rules, and can manually issue / revoke
-- certificates. Public /verify/{cert_uuid} is served elsewhere.

CREATE TABLE IF NOT EXISTS certificate_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,  -- background/font/colour/layout/logo/signature
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS certification_rules (
  topic_id            UUID PRIMARY KEY REFERENCES content_topics(id) ON DELETE CASCADE,
  min_completion_pct  INTEGER NOT NULL DEFAULT 80 CHECK (min_completion_pct BETWEEN 0 AND 100),
  min_assessment_pct  INTEGER NOT NULL DEFAULT 70 CHECK (min_assessment_pct BETWEEN 0 AND 100),
  requires_offline    BOOLEAN NOT NULL DEFAULT FALSE,
  expiry_mode         TEXT NOT NULL DEFAULT 'lifetime' CHECK (expiry_mode IN ('lifetime','expiry')),
  validity_days       INTEGER CHECK (validity_days IS NULL OR validity_days > 0),
  template_id         UUID REFERENCES certificate_templates(id) ON DELETE SET NULL,
  updated_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS certificates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cert_uuid       UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_id        UUID REFERENCES content_topics(id) ON DELETE SET NULL,
  learner_name    TEXT NOT NULL,
  course_name     TEXT NOT NULL,
  template_id     UUID REFERENCES certificate_templates(id) ON DELETE SET NULL,
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  revoked_at      TIMESTAMPTZ,
  revoked_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_reason  TEXT
);
CREATE INDEX IF NOT EXISTS certificates_user_idx  ON certificates(user_id);
CREATE INDEX IF NOT EXISTS certificates_status_idx ON certificates(status, issued_at DESC);
