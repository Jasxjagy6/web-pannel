-- =====================================================================
-- Migration v7: OxaPay subscriptions, free trial, payment history
-- =====================================================================
-- Adds the schema for the institutional billing layer:
--   * system_settings  - admin-tunable singletons (price, trial config, …)
--   * payment_invoices - one row per OxaPay invoice; lifecycle audited
--   * subscription_events - human/admin readable audit trail per user
--
-- Plus a small extension to `users` for trial-grant tracking that we
-- couldn't squeeze into the existing JSONB without making it ambiguous:
--   * trial_started_at / trial_expires_at — flat timestamps so we can
--     index/query "who is in trial now?" cheaply
-- =====================================================================

-- ---------------------------------------------------------------------
-- system_settings: a single source of truth for admin-tunable values.
-- We store JSONB values so the same table can hold the price, the trial
-- toggle, the trial duration, the trial feature whitelist, etc.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_settings (
  key         VARCHAR(100) PRIMARY KEY,
  value       JSONB        NOT NULL,
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- Seed the billing defaults on first install. Re-running the migration
-- preserves whatever the admin has already configured.
INSERT INTO system_settings (key, value) VALUES
  ('billing.subscription_price_usd', '9.99'::jsonb),
  ('billing.subscription_period_days', '30'::jsonb),
  ('billing.currency', '"USD"'::jsonb),
  ('billing.trial_enabled', 'true'::jsonb),
  ('billing.trial_duration_minutes', '5'::jsonb),
  ('billing.trial_allowed_features',
   '["dashboard","sessions","scrape","messaging","groups","lists","reports","get_otp","change_2fa","proxies","anti_detect","privacy"]'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------
-- payment_invoices: a row per OxaPay invoice we create.
-- We never delete these — the admin's payment-history dashboard relies
-- on the full audit, including failed/cancelled invoices.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_invoices (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- OxaPay's "trackId" / "track_id" is what their callback echoes back
  oxapay_track_id VARCHAR(255) UNIQUE,
  amount_usd      NUMERIC(10, 2) NOT NULL,
  currency        VARCHAR(10)  NOT NULL DEFAULT 'USD',
  status          VARCHAR(20)  NOT NULL DEFAULT 'pending',
  pay_link        TEXT,
  payment_url     TEXT,
  -- Whatever OxaPay returned at create-time / last callback. Stored
  -- raw so we can debug a customer's payment without re-hitting the API.
  raw_create      JSONB        NOT NULL DEFAULT '{}'::jsonb,
  raw_callback    JSONB,
  paid_at         TIMESTAMP,
  expires_at      TIMESTAMP,
  -- After a successful payment we always extend the user's subscription
  -- by `subscription_period_days`; this column records the new expiry
  -- so the admin can correlate a payment to the specific window it
  -- bought.
  granted_until   TIMESTAMP,
  notes           TEXT,
  created_at      TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP    NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE payment_invoices DROP CONSTRAINT IF EXISTS payment_invoices_status_check;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

ALTER TABLE payment_invoices
  ADD CONSTRAINT payment_invoices_status_check
  CHECK (status IN ('pending', 'paid', 'expired', 'cancelled', 'failed', 'refunded'));

CREATE INDEX IF NOT EXISTS idx_payment_invoices_user
  ON payment_invoices (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_invoices_status
  ON payment_invoices (status, created_at DESC);

-- ---------------------------------------------------------------------
-- subscription_events: append-only audit trail.
-- Captures grants, expiries, manual admin overrides, trial activation,
-- and oxapay payment outcomes. Used to power both the user-facing
-- "Subscription history" widget and the admin payment dashboard.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscription_events (
  id           BIGSERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invoice_id   INTEGER REFERENCES payment_invoices(id) ON DELETE SET NULL,
  event_type   VARCHAR(50) NOT NULL,
  description  TEXT,
  details      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscription_events_user
  ON subscription_events (user_id, created_at DESC);

-- ---------------------------------------------------------------------
-- Trial tracking on users. We don't want to lose this when an admin
-- overwrites subscription_features, so it lives in flat columns.
-- ---------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS trial_started_at  TIMESTAMP,
  ADD COLUMN IF NOT EXISTS trial_expires_at  TIMESTAMP,
  ADD COLUMN IF NOT EXISTS trial_used        BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_users_trial_expires
  ON users (trial_expires_at) WHERE trial_expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_subscription_expires
  ON users (subscription_expires_at) WHERE subscription_expires_at IS NOT NULL;
