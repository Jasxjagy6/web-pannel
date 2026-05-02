-- =============================================================================
-- Migration v9_3 — per-platform subscription split
-- =============================================================================
-- The legacy single-row-per-user subscription model on `users.subscription_*`
-- becomes a per-(user, platform) row in a new `user_subscriptions` table.
--
-- The legacy columns are KEPT for one release as a read-only mirror so any
-- tooling that hasn't been updated still sees data; a follow-up migration
-- removes them.
--
-- This migration is idempotent: re-running it does NOT clobber the
-- per-platform rows (the backfill uses ON CONFLICT (user_id, platform)
-- DO NOTHING).
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_subscriptions (
  id                 SERIAL PRIMARY KEY,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform           platform_type NOT NULL,
  plan               VARCHAR(50),
  status             VARCHAR(20) NOT NULL DEFAULT 'inactive'
                       CHECK (status IN ('inactive','active','expired','cancelled')),
  expires_at         TIMESTAMP,
  features           JSONB NOT NULL DEFAULT '{}'::jsonb,
  trial_started_at   TIMESTAMP,
  trial_expires_at   TIMESTAMP,
  trial_used         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_platform
  ON user_subscriptions(user_id, platform);

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_active_expiring
  ON user_subscriptions(status, expires_at)
  WHERE status = 'active' AND expires_at IS NOT NULL;

-- Backfill: every existing user gets a 'telegram' row mirroring their legacy
-- subscription state. The legacy columns are still authoritative until the
-- application starts writing through user_subscriptions (see
-- subscriptionService).
INSERT INTO user_subscriptions
  (user_id, platform, plan, status, expires_at, features,
   trial_started_at, trial_expires_at, trial_used,
   created_at, updated_at)
SELECT
  id,
  'telegram'::platform_type,
  COALESCE(subscription_plan, NULL),
  COALESCE(subscription_status, 'inactive'),
  subscription_expires_at,
  COALESCE(subscription_features, '{}'::jsonb),
  trial_started_at,
  trial_expires_at,
  COALESCE(trial_used, FALSE),
  COALESCE(created_at, NOW()),
  COALESCE(updated_at, NOW())
FROM users
ON CONFLICT (user_id, platform) DO NOTHING;

-- payment_invoices and subscription_events: stamp the platform on the audit
-- trail. Default to 'telegram' for the existing rows.
ALTER TABLE payment_invoices
  ADD COLUMN IF NOT EXISTS platform platform_type NOT NULL DEFAULT 'telegram';

ALTER TABLE subscription_events
  ADD COLUMN IF NOT EXISTS platform platform_type NOT NULL DEFAULT 'telegram';

CREATE INDEX IF NOT EXISTS idx_payment_invoices_user_platform_status
  ON payment_invoices(user_id, platform, status);

CREATE INDEX IF NOT EXISTS idx_subscription_events_user_platform_created
  ON subscription_events(user_id, platform, created_at DESC);
