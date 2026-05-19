-- 007_vendors.sql  (vidyouth-admin-backend owns vendor + batch admin)
--
-- PRD §7.5 Vendor + §7.6 Vendor Management + §8.5 Offline Training.
-- Admin creates/edits vendor accounts and offline batches, and assigns
-- a vendor per batch. Attendance/scoring is the Vendor Portal's job.

CREATE TABLE IF NOT EXISTS vendors (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  contact_email   CITEXT,
  contact_mobile  TEXT,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  organisation_id UUID REFERENCES organisations(id) ON DELETE SET NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS offline_batches (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id    UUID REFERENCES content_topics(id) ON DELETE SET NULL,
  vendor_id   UUID REFERENCES vendors(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  location    TEXT,
  start_date  DATE,
  end_date    DATE,
  max_seats   INTEGER CHECK (max_seats IS NULL OR max_seats > 0),
  hybrid_pct  INTEGER NOT NULL DEFAULT 0 CHECK (hybrid_pct BETWEEN 0 AND 100),
  status      TEXT NOT NULL DEFAULT 'scheduled'
              CHECK (status IN ('scheduled','active','completed','cancelled')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS offline_batches_vendor_idx ON offline_batches(vendor_id);
CREATE INDEX IF NOT EXISTS offline_batches_topic_idx  ON offline_batches(topic_id);
