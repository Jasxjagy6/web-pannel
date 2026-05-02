-- =====================================================================
-- Migration v9: Per-job dedup + bot-filter toggles for the live scrape
--               monitor (admin-only-chat path).
-- =====================================================================
--
-- The original v6 monitor enforced "one row per (job, telegram_id)" via
-- a hard UNIQUE constraint and an `INSERT ... ON CONFLICT DO UPDATE`
-- upsert. Two operational requests changed the contract:
--
--   1. "Allow duplicates" mode — when the user wants every interaction
--      recorded (e.g. a chatty user shows up N times so a downstream
--      consumer can weight by activity). The hard UNIQUE constraint
--      makes that impossible, so we drop it and move dedup to
--      application code, gated by a per-job flag.
--
--   2. "Bot filter" mode — when the user wants `is_bot = TRUE` senders
--      excluded from the captured set entirely, rather than counted and
--      then filtered visually.
--
-- This migration:
--   * Adds the two boolean toggles to scrape_monitor_jobs with sane
--     defaults (`dedup_enabled = TRUE`, `bot_filter_enabled = FALSE`)
--     so existing rows continue to behave exactly as they did under v6.
--   * Drops the UNIQUE(monitor_job_id, telegram_id) constraint without
--     dropping the index — we still want the lookup to be fast for the
--     application-level dedup SELECT.
--   * Replaces the dropped UNIQUE with a plain composite INDEX so the
--     dedup SELECT remains O(log n).
--
-- The migration is idempotent: running it twice is a no-op.
-- =====================================================================

ALTER TABLE scrape_monitor_jobs
  ADD COLUMN IF NOT EXISTS dedup_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS bot_filter_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN scrape_monitor_jobs.dedup_enabled IS
  'When TRUE (default), the monitor merges repeat sightings of the same telegram_id into a single row and bumps message_count. When FALSE, every observed message inserts a new row.';

COMMENT ON COLUMN scrape_monitor_jobs.bot_filter_enabled IS
  'When TRUE, observed senders with is_bot=TRUE are skipped at insert time and never appear in the captured user list. When FALSE (default), bots are recorded with is_bot=TRUE and the UI can filter them visually.';

-- ---------------------------------------------------------------------
-- Drop the auto-generated UNIQUE on (monitor_job_id, telegram_id) so we
-- can support the dedup_enabled=FALSE mode. Postgres named the
-- constraint `scrape_monitor_users_monitor_job_id_telegram_id_key` when
-- v6 ran, but we look it up by definition to be safe across rename
-- variations.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  cname TEXT;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'scrape_monitor_users'::regclass
     AND contype  = 'u'
     AND pg_get_constraintdef(oid) ILIKE '%(monitor_job_id, telegram_id)%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE scrape_monitor_users DROP CONSTRAINT %I', cname);
  END IF;
END $$;

-- Replacement index — fast lookup for the application-level dedup
-- SELECT. NOT UNIQUE so dedup_enabled=FALSE jobs can co-exist.
CREATE INDEX IF NOT EXISTS idx_scrape_monitor_users_job_tg
  ON scrape_monitor_users(monitor_job_id, telegram_id);
