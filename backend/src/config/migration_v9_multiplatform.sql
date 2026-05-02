-- =============================================================================
-- Migration v9 — multi-platform foundation
-- =============================================================================
-- Adds the `platform` enum, the `platform` column on every per-account table,
-- platform-aware indexes, and seeds per-platform billing settings.
--
-- All statements are idempotent so the migration can be re-run safely. Backfill
-- of the existing rows defaults to 'telegram' so legacy users / sessions /
-- jobs are unchanged after the migration runs.
-- =============================================================================

-- 1. The platform enum -------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'platform_type') THEN
    CREATE TYPE platform_type AS ENUM ('telegram', 'instagram');
  END IF;
END$$;

-- 2. Per-account tables gain a `platform` column -----------------------------
-- All defaults are 'telegram' so existing rows keep their semantics; new IG
-- rows must specify 'instagram' explicitly.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS platform platform_type NOT NULL DEFAULT 'telegram',
  ADD COLUMN IF NOT EXISTS username VARCHAR(150);

ALTER TABLE scraping_jobs
  ADD COLUMN IF NOT EXISTS platform platform_type NOT NULL DEFAULT 'telegram';

ALTER TABLE scraped_users
  ADD COLUMN IF NOT EXISTS platform platform_type NOT NULL DEFAULT 'telegram',
  ADD COLUMN IF NOT EXISTS instagram_pk BIGINT,
  ADD COLUMN IF NOT EXISTS full_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS is_private BOOLEAN,
  ADD COLUMN IF NOT EXISTS is_verified BOOLEAN;

ALTER TABLE messaging_jobs
  ADD COLUMN IF NOT EXISTS platform platform_type NOT NULL DEFAULT 'telegram';

ALTER TABLE message_logs
  ADD COLUMN IF NOT EXISTS platform platform_type NOT NULL DEFAULT 'telegram';

ALTER TABLE group_operations
  ADD COLUMN IF NOT EXISTS platform platform_type NOT NULL DEFAULT 'telegram';

ALTER TABLE lists
  ADD COLUMN IF NOT EXISTS platform platform_type NOT NULL DEFAULT 'telegram';

ALTER TABLE list_items
  ADD COLUMN IF NOT EXISTS platform platform_type NOT NULL DEFAULT 'telegram',
  ADD COLUMN IF NOT EXISTS instagram_pk BIGINT;

ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS platform platform_type NOT NULL DEFAULT 'telegram';

ALTER TABLE activity_logs
  ADD COLUMN IF NOT EXISTS platform platform_type;

-- v6 monitor table (created in migration_v6_scrape_monitor.sql).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'scrape_monitor_jobs') THEN
    EXECUTE 'ALTER TABLE scrape_monitor_jobs
              ADD COLUMN IF NOT EXISTS platform platform_type NOT NULL DEFAULT ''telegram''';
  END IF;
END$$;

-- v2 twoFA jobs table.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'twofa_jobs') THEN
    EXECUTE 'ALTER TABLE twofa_jobs
              ADD COLUMN IF NOT EXISTS platform platform_type NOT NULL DEFAULT ''telegram''';
  END IF;
END$$;

-- v2 OTP scans table.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'otp_scans') THEN
    EXECUTE 'ALTER TABLE otp_scans
              ADD COLUMN IF NOT EXISTS platform platform_type NOT NULL DEFAULT ''telegram''';
  END IF;
END$$;

-- v4 privacy jobs.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'privacy_jobs') THEN
    EXECUTE 'ALTER TABLE privacy_jobs
              ADD COLUMN IF NOT EXISTS platform platform_type NOT NULL DEFAULT ''telegram''';
  END IF;
END$$;

-- Proxies are validated per platform target — a proxy that works for Telegram
-- (DC4 endpoint) may not work for Instagram (i.instagram.com:443) or vice
-- versa.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'proxies') THEN
    EXECUTE 'ALTER TABLE proxies
              ADD COLUMN IF NOT EXISTS validated_for_telegram BOOLEAN NOT NULL DEFAULT FALSE,
              ADD COLUMN IF NOT EXISTS validated_for_instagram BOOLEAN NOT NULL DEFAULT FALSE,
              ADD COLUMN IF NOT EXISTS last_validated_telegram_at TIMESTAMP,
              ADD COLUMN IF NOT EXISTS last_validated_instagram_at TIMESTAMP';
  END IF;
END$$;

-- Per-user API credentials stay Telegram-scoped for now; the `platform`
-- column is added so the table is ready if Instagram ever needs a per-user
-- credential analog.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_api_credentials') THEN
    EXECUTE 'ALTER TABLE user_api_credentials
              ADD COLUMN IF NOT EXISTS platform platform_type NOT NULL DEFAULT ''telegram''';
  END IF;
END$$;

-- Existing groups table cache (Telegram channels/supergroups). Add an
-- external_type column so Instagram DM threads can be stored alongside.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'groups') THEN
    EXECUTE 'ALTER TABLE groups
              ADD COLUMN IF NOT EXISTS platform platform_type NOT NULL DEFAULT ''telegram'',
              ADD COLUMN IF NOT EXISTS external_type VARCHAR(20)';
  END IF;
END$$;

-- 3. Platform-aware indexes --------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_sessions_user_platform_logged_in
  ON sessions(user_id, platform, is_logged_in);

CREATE INDEX IF NOT EXISTS idx_scraping_jobs_user_platform_status
  ON scraping_jobs(user_id, platform, status);

CREATE INDEX IF NOT EXISTS idx_messaging_jobs_user_platform_status
  ON messaging_jobs(user_id, platform, status);

CREATE INDEX IF NOT EXISTS idx_lists_user_platform
  ON lists(user_id, platform);

CREATE INDEX IF NOT EXISTS idx_reports_user_platform
  ON reports(user_id, platform);

-- 4. Per-platform billing settings -------------------------------------------
-- These mirror the existing `billing.subscription_*` keys and add Instagram
-- equivalents plus a bundle SKU.
INSERT INTO system_settings (key, value, updated_at) VALUES
  ('billing.telegram.subscription_price_usd',   '9.99'::jsonb,  NOW()),
  ('billing.telegram.subscription_period_days', '30'::jsonb,    NOW()),
  ('billing.telegram.trial_enabled',            'true'::jsonb,  NOW()),
  ('billing.telegram.trial_duration_minutes',   '5'::jsonb,     NOW()),
  ('billing.telegram.trial_allowed_features',
    '["dashboard","sessions","scrape","messaging","groups","lists","reports","get_otp","change_2fa","proxies","anti_detect","privacy"]'::jsonb,
    NOW()),
  ('billing.instagram.subscription_price_usd',   '9.99'::jsonb, NOW()),
  ('billing.instagram.subscription_period_days', '30'::jsonb,   NOW()),
  ('billing.instagram.trial_enabled',            'true'::jsonb, NOW()),
  ('billing.instagram.trial_duration_minutes',   '5'::jsonb,    NOW()),
  ('billing.instagram.trial_allowed_features',
    '["dashboard","sessions","scrape","messaging","threads","lists","reports","change_2fa","proxies","anti_detect","privacy"]'::jsonb,
    NOW()),
  ('billing.bundle.tg_plus_ig.price_usd',   '14.99'::jsonb, NOW()),
  ('billing.bundle.tg_plus_ig.period_days', '30'::jsonb,    NOW()),
  ('messaging.instagram.daily_cap_default',  '30'::jsonb,   NOW()),
  ('messaging.instagram.hourly_cap_default', '10'::jsonb,   NOW()),
  ('messaging.instagram.warmup_days',        '7'::jsonb,    NOW())
ON CONFLICT (key) DO NOTHING;
