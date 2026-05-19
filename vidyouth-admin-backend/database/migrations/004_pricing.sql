-- 004_pricing.sql  (vidyouth-admin-backend owns pricing config)
--
-- PRD §9.1 Monetization Models + §9.2 Pricing Configuration Rules.
-- Admin-configured: membership plans, discount codes, per-topic pricing
-- rules (validity / early-bird / pay-per-watch), org bulk pricing.

CREATE TABLE IF NOT EXISTS membership_plans (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  tier          TEXT NOT NULL CHECK (tier IN ('basic','pro','premium')),
  price_inr     NUMERIC(10,2) NOT NULL CHECK (price_inr >= 0),
  billing_period TEXT NOT NULL CHECK (billing_period IN ('monthly','annual','lifetime')),
  features      JSONB NOT NULL DEFAULT '[]'::jsonb,
  auto_renew    BOOLEAN NOT NULL DEFAULT TRUE,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS discount_codes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code            CITEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL CHECK (kind IN ('percentage','fixed')),
  value           NUMERIC(10,2) NOT NULL CHECK (value > 0),
  expires_at      TIMESTAMPTZ,
  usage_limit     INTEGER CHECK (usage_limit IS NULL OR usage_limit > 0),
  per_user_limit  INTEGER CHECK (per_user_limit IS NULL OR per_user_limit > 0),
  times_used      INTEGER NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (kind <> 'percentage' OR value <= 100)
);

-- One pricing rule row per topic (early-bird + validity + pay-per-watch).
CREATE TABLE IF NOT EXISTS topic_pricing_rules (
  topic_id            UUID PRIMARY KEY REFERENCES content_topics(id) ON DELETE CASCADE,
  base_price_inr      NUMERIC(10,2) CHECK (base_price_inr IS NULL OR base_price_inr >= 0),
  validity_days       INTEGER CHECK (validity_days IS NULL OR validity_days > 0),
  early_bird_price_inr NUMERIC(10,2) CHECK (early_bird_price_inr IS NULL OR early_bird_price_inr >= 0),
  early_bird_until    TIMESTAMPTZ,
  ppw_paise_per_min   INTEGER CHECK (ppw_paise_per_min IS NULL OR ppw_paise_per_min >= 0),
  updated_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Special bulk price per (organisation, topic) — PRD §9.2 org pricing.
CREATE TABLE IF NOT EXISTS org_topic_pricing (
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  topic_id        UUID NOT NULL REFERENCES content_topics(id) ON DELETE CASCADE,
  price_inr       NUMERIC(10,2) NOT NULL CHECK (price_inr >= 0),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organisation_id, topic_id)
);
