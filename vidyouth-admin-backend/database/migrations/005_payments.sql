-- 005_payments.sql  (vidyouth-admin-backend owns wallet + txn views)
--
-- PRD §9.3 Wallet Module + §9.4 Razorpay + §7.6 Payment Management.
-- Amounts are stored in paise (integer) to avoid float drift. The
-- payment service writes transactions in prod; admin views/refunds them
-- and manually adjusts wallets. platform_settings (002) holds config.

CREATE TABLE IF NOT EXISTS wallets (
  user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance_paise BIGINT NOT NULL DEFAULT 0 CHECK (balance_paise >= 0),
  bonus_paise   BIGINT NOT NULL DEFAULT 0 CHECK (bonus_paise >= 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallet_ledger (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN
                       ('credit','debit','bonus','refund','adjustment')),
  amount_paise       BIGINT NOT NULL,
  description        TEXT,
  balance_after_paise BIGINT NOT NULL,
  created_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS wallet_ledger_user_idx
  ON wallet_ledger(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_transactions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  amount_paise BIGINT NOT NULL CHECK (amount_paise >= 0),
  currency     TEXT NOT NULL DEFAULT 'INR',
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','captured','failed','refunded')),
  gateway      TEXT NOT NULL DEFAULT 'razorpay',
  gateway_ref  TEXT,
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS payment_txn_status_idx ON payment_transactions(status, created_at DESC);
CREATE INDEX IF NOT EXISTS payment_txn_user_idx   ON payment_transactions(user_id, created_at DESC);
