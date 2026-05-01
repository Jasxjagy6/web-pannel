-- =====================================================================
-- Migration v5: Multi-User + Admin + Subscription
-- =====================================================================
-- Adds the columns needed to turn the panel from single-admin into a
-- multi-tenant system with:
--   * Per-user registration via email + password (bcrypt hashed)
--   * User roles ("user" | "admin")
--   * Per-user status (pending | approved | banned)
--   * Subscription scaffolding (plan, granted features, expiry)
--   * Admin audit log (who approved/banned whom)
--
-- All statements are idempotent so the migration can be re-applied
-- safely against environments that have already been partially upgraded.
-- =====================================================================

-- ----------------------------------------------------------------------
-- Users: registration + approval + subscription
-- ----------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'pending';

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_approved BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS approved_by INTEGER;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS banned_at TIMESTAMP;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS banned_reason TEXT;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS subscription_plan VARCHAR(50);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(20) NOT NULL DEFAULT 'inactive';

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMP;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS subscription_features JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS notes TEXT;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();

-- Status check (idempotent: drop + recreate constraint).
DO $$ BEGIN
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

ALTER TABLE users
  ADD CONSTRAINT users_status_check
  CHECK (status IN ('pending', 'approved', 'banned'));

-- Subscription status check.
DO $$ BEGIN
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_subscription_status_check;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

ALTER TABLE users
  ADD CONSTRAINT users_subscription_status_check
  CHECK (subscription_status IN ('inactive', 'active', 'expired', 'cancelled'));

-- Promote any pre-existing admin row to approved + active.
UPDATE users
   SET status = 'approved',
       is_approved = TRUE,
       approved_at = COALESCE(approved_at, NOW()),
       subscription_status = 'active',
       subscription_plan = COALESCE(subscription_plan, 'admin'),
       subscription_features = COALESCE(subscription_features, '{}'::jsonb) || '{"all":true}'::jsonb,
       updated_at = NOW()
 WHERE role = 'admin';

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users(LOWER(email));

-- ----------------------------------------------------------------------
-- Add user_id ownership to tables that only had session_id ownership.
-- This lets the worker reject jobs whose owner has been banned and
-- lets admin endpoints attribute jobs cleanly without joining sessions.
-- ----------------------------------------------------------------------
ALTER TABLE scraping_jobs
  ADD COLUMN IF NOT EXISTS user_id INTEGER;

UPDATE scraping_jobs sj
   SET user_id = s.user_id
  FROM sessions s
 WHERE sj.session_id = s.id
   AND sj.user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_scraping_jobs_user
  ON scraping_jobs(user_id, created_at DESC);

ALTER TABLE messaging_jobs
  ADD COLUMN IF NOT EXISTS user_id INTEGER;

UPDATE messaging_jobs mj
   SET user_id = s.user_id
  FROM sessions s
 WHERE mj.session_id = s.id
   AND mj.user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_messaging_jobs_user
  ON messaging_jobs(user_id, created_at DESC);

ALTER TABLE behavior_log
  ADD COLUMN IF NOT EXISTS user_id INTEGER;

UPDATE behavior_log bl
   SET user_id = s.user_id
  FROM sessions s
 WHERE bl.session_id = s.id
   AND bl.user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_behavior_log_user
  ON behavior_log(user_id, performed_at DESC);

-- Privacy job items already join through privacy_jobs.user_id; nothing
-- extra needed there. Same for change_2fa_jobs / otp_jobs (already
-- carry user_id from migration v2).

-- ----------------------------------------------------------------------
-- Admin audit log: every action a sysadmin performs against another
-- user (approve / ban / set subscription / delete) is recorded here.
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_actions (
  id BIGSERIAL PRIMARY KEY,
  admin_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action VARCHAR(64) NOT NULL,
  reason TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  performed_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_actions_target
  ON admin_actions(target_user_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_actions_admin
  ON admin_actions(admin_user_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_actions_recent
  ON admin_actions(performed_at DESC);
