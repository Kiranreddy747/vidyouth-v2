-- 003_content.sql  (vidyouth-admin-backend owns the content tree)
--
-- PRD §8.2 FR-CONTENT-001 "Hierarchical Content Tree" — the platform's
-- core USP: Sector → Sub-Sector → Topic → Subtopic (≤3 deep) → Content
-- Items. Pricing/enrolment live on the Topic. Everything soft-deactivates
-- (is_active) and is orderable (sort_order).

CREATE TABLE IF NOT EXISTS content_sectors (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        CITEXT NOT NULL UNIQUE,
  icon_url    TEXT,
  banner_url  TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS content_sub_sectors (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sector_id   UUID NOT NULL REFERENCES content_sectors(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  slug        CITEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sector_id, slug)
);
CREATE INDEX IF NOT EXISTS sub_sectors_sector_idx ON content_sub_sectors(sector_id);

CREATE TABLE IF NOT EXISTS content_topics (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sub_sector_id   UUID NOT NULL REFERENCES content_sub_sectors(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  slug            CITEXT NOT NULL,
  description     TEXT,
  price_inr       NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (price_inr >= 0),
  is_subscription BOOLEAN NOT NULL DEFAULT FALSE,
  validity_days   INTEGER CHECK (validity_days IS NULL OR validity_days > 0),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sub_sector_id, slug)
);
CREATE INDEX IF NOT EXISTS topics_sub_sector_idx ON content_topics(sub_sector_id);

-- Subtopics self-nest to a maximum depth of 3 (FR-CONTENT-001 4a/4b/4c).
CREATE TABLE IF NOT EXISTS content_subtopics (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id            UUID NOT NULL REFERENCES content_topics(id) ON DELETE CASCADE,
  parent_subtopic_id  UUID REFERENCES content_subtopics(id) ON DELETE CASCADE,
  depth               INTEGER NOT NULL DEFAULT 1 CHECK (depth BETWEEN 1 AND 3),
  name                TEXT NOT NULL,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS subtopics_topic_idx  ON content_subtopics(topic_id);
CREATE INDEX IF NOT EXISTS subtopics_parent_idx ON content_subtopics(parent_subtopic_id);

-- Content items attach to a Topic OR a Subtopic (exactly one).
CREATE TABLE IF NOT EXISTS content_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id      UUID REFERENCES content_topics(id) ON DELETE CASCADE,
  subtopic_id   UUID REFERENCES content_subtopics(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN
                  ('document','video','live_session','recorded_session',
                   'offline_training','quiz','external_link')),
  title         TEXT NOT NULL,
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_downloadable BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((topic_id IS NOT NULL) <> (subtopic_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS content_items_topic_idx    ON content_items(topic_id);
CREATE INDEX IF NOT EXISTS content_items_subtopic_idx ON content_items(subtopic_id);
