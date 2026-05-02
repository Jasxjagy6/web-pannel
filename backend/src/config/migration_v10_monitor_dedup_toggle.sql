-- =====================================================================
-- Migration v10: Configurable deduplication for the live scrape MONITOR
-- =====================================================================
-- Why
-- ---
-- The v6 monitor pinned its dedup contract via a hard
-- UNIQUE(monitor_job_id, telegram_id) constraint, with the upsert query
-- relying on `ON CONFLICT (...)` to bump message_count. Operators have
-- since asked for the opposite mode too — i.e. "save EVERY interaction
-- as its own row, even from the same user" — so we can produce a true
-- raw activity log for chats they want to audit message-for-message.
--
-- This migration:
--
--   1. Adds `dedup_enabled` (BOOLEAN, default TRUE) to scrape_monitor_jobs
--      so each monitor job remembers its own contract. Existing rows
--      keep the v6 default (deduplicating by telegram_id), so nothing
--      that's already running changes behavior.
--
--   2. Adds `events_observed` (INTEGER, default 0) to
--      scrape_monitor_jobs. This is incremented for EVERY accepted
--      NewMessage event regardless of dedup, so the panel can show
--      the operator how many messages we actually heard versus how
--      many distinct users we recorded — the gap between the two is
--      a strong diagnostic signal when a session looks "quiet".
--
--   3. Drops the v6 UNIQUE(monitor_job_id, telegram_id) constraint and
--      replaces it with a plain composite index. The application code
--      (services/scrapeMonitorService.js::_onEvent) now branches on
--      `dedup_enabled`: when TRUE it does SELECT-then-INSERT-or-UPDATE
--      so we still record exactly one row per user per job; when FALSE
--      it does a plain INSERT so every observed message is its own row.
--      Keeping a non-unique composite index preserves the O(log n)
--      lookup cost of the dedup branch.
--
-- All statements are idempotent — this migration is safe to re-run
-- and safe to apply on top of any prior partial attempts.
-- =====================================================================

-- 1. dedup_enabled flag on the job row.
ALTER TABLE scrape_monitor_jobs
  ADD COLUMN IF NOT EXISTS dedup_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN scrape_monitor_jobs.dedup_enabled IS
  'TRUE (v6 default): one row per (job, telegram_id) — repeat senders bump message_count. FALSE: every observed message is inserted as its own row.';

-- 2. events_observed counter on the job row. Tracks EVERY accepted
--    NewMessage event regardless of dedup mode.
ALTER TABLE scrape_monitor_jobs
  ADD COLUMN IF NOT EXISTS events_observed INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN scrape_monitor_jobs.events_observed IS
  'Total NewMessage events that passed the chat filter and had an extractable sender. Independent of dedup_enabled — the gap between events_observed and scraped_count tells the operator how many were repeats.';

-- 3. Drop the v6 UNIQUE constraint that pinned dedup at the DB layer.
--    Postgres names the auto-generated constraint differently in
--    different versions, so we hunt it down by definition rather than
--    relying on a fixed name.
DO $$
DECLARE
  cname TEXT;
BEGIN
  FOR cname IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'scrape_monitor_users'::regclass
       AND contype = 'u'
       AND pg_get_constraintdef(oid) ILIKE '%(monitor_job_id, telegram_id)%'
  LOOP
    EXECUTE format(
      'ALTER TABLE scrape_monitor_users DROP CONSTRAINT IF EXISTS %I',
      cname
    );
  END LOOP;
END $$;

-- Older Postgres versions back the constraint with an index of the same
-- name; some manual rebuilds leave the index behind even after the
-- constraint is dropped. Drop any leftover unique index on the same
-- pair so the non-unique replacement below can be created cleanly.
DO $$
DECLARE
  iname TEXT;
BEGIN
  FOR iname IN
    SELECT indexrelid::regclass::text
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
     WHERE c.relname = 'scrape_monitor_users'
       AND i.indisunique
       AND pg_get_indexdef(i.indexrelid) ILIKE '%(monitor_job_id, telegram_id)%'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %s', iname);
  END LOOP;
END $$;

-- 4. Replacement non-unique composite index so dedup-mode lookups
--    (SELECT id FROM scrape_monitor_users WHERE monitor_job_id=$1 AND
--    telegram_id=$2) stay cheap.
CREATE INDEX IF NOT EXISTS idx_scrape_monitor_users_job_tg
  ON scrape_monitor_users(monitor_job_id, telegram_id);

-- 5. Sanity-check index used by the user listing endpoint
--    (already created in v6, but listed here so the v10 file is
--    self-describing and re-running it reapplies all expected indexes).
CREATE INDEX IF NOT EXISTS idx_scrape_monitor_users_job_seen
  ON scrape_monitor_users(monitor_job_id, last_seen_at DESC);
