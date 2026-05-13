-- =====================================================================
-- Migration v29: Restore race-safe dedup for the legacy monitor path.
-- =====================================================================
--
-- Background
-- ----------
-- v6 protected `scrape_monitor_users` with a hard
-- `UNIQUE(monitor_job_id, telegram_id)` constraint, and the
-- `ON CONFLICT (monitor_job_id, telegram_id) DO UPDATE` upsert in
-- `_recordProfile` relied on that constraint to be race-safe.
--
-- v10 (`migration_v10_monitor_dedup_toggle.sql`) dropped that UNIQUE so
-- operators could opt-in to the "save every observed message" mode. To
-- preserve the "save exactly one row per distinct user" contract for
-- the dedup-on case, v10 rewrote the upsert into a plain
-- `SELECT … then INSERT or UPDATE`, branching on `dedup_enabled`.
--
-- The SELECT-then-INSERT is not atomic. When more than one session is
-- attached to the same chat — which is the default in production
-- (sessionIds: [N…M], 5-40 sessions per job) — every NewMessage event
-- fires the handler in parallel on every session. All N handlers run
-- the SELECT, none find an existing row (the first INSERT hasn't
-- committed yet), and every handler INSERTs. Result: ~N rows per real
-- message instead of 1, observed in production as "100 rows but only
-- 3-4 distinct users".
--
-- v28 (`migration_v28_monitor_v2.sql`) restored a partial unique
-- index for the v2 path:
--   uniq_smusers_chat_tg ON (monitor_chat_id, telegram_id)
--                            WHERE monitor_chat_id IS NOT NULL
-- That is correct, but only covers v2 jobs. Legacy jobs (which is
-- where all real traffic still goes today, see PR #92's
-- `_isV2Job` controller routing) have `monitor_chat_id IS NULL`
-- and are unprotected.
--
-- v29 closes the gap without breaking the v10 "save every message"
-- mode:
--
--   1. Adds `dedup_locked` to `scrape_monitor_users` so each row
--      remembers whether it was inserted under the dedup-on contract
--      (TRUE, default) or the dedup-off contract (FALSE).
--   2. Creates `uniq_smusers_job_tg_dedup`, a partial UNIQUE on
--      (monitor_job_id, telegram_id) WHERE dedup_locked AND
--      monitor_chat_id IS NULL. This covers the legacy v6/v10 dedup-on
--      path and stays out of the way of:
--         * v2 rows (monitor_chat_id IS NOT NULL — already covered by
--                    uniq_smusers_chat_tg)
--         * dedup-off rows (dedup_locked = FALSE — partial WHERE excludes them)
--   3. Backfills existing dedup-on rows so they are `dedup_locked = TRUE`
--      ready for the unique index. Before creating the index we
--      delete obvious duplicates that the v10 race already inserted,
--      keeping the row with the lowest id (earliest insert) per
--      (monitor_job_id, telegram_id) and summing the `message_count` /
--      `events_observed` onto the survivor so historic exports stay
--      consistent.
--
-- After this migration the application code (scrapeMonitorService.js
-- `_recordProfile`) switches to a single
--   INSERT … ON CONFLICT (monitor_job_id, telegram_id)
--             WHERE dedup_locked AND monitor_chat_id IS NULL
--             DO UPDATE …
-- which is atomic and survives N parallel sessions on the same chat.
--
-- All statements are idempotent.
-- =====================================================================

-- 1. dedup_locked marker on each observation row.
ALTER TABLE scrape_monitor_users
  ADD COLUMN IF NOT EXISTS dedup_locked BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN scrape_monitor_users.dedup_locked IS
  'TRUE when this row was inserted under the dedup-on contract (one row per (job, telegram_id)) and so participates in the legacy partial UNIQUE. FALSE when this row was inserted under dedup-off (raw activity log) — those rows intentionally repeat per observation and are excluded from the partial UNIQUE.';

-- 2. Backfill existing rows so historic dedup-on rows are protected.
--    We use the job-level `dedup_enabled` flag as the source of truth.
UPDATE scrape_monitor_users u
   SET dedup_locked = COALESCE(j.dedup_enabled, TRUE)
  FROM scrape_monitor_jobs j
 WHERE u.monitor_job_id = j.id
   AND u.dedup_locked IS DISTINCT FROM COALESCE(j.dedup_enabled, TRUE);

-- 3. Collapse the duplicates the v10 race already inserted, BEFORE we
--    try to create the unique index. We keep the row with the lowest
--    id per (monitor_job_id, telegram_id) for legacy (chat IS NULL)
--    dedup-on rows, and roll the message_count / first_seen_at /
--    last_seen_at onto it.
DO $$
DECLARE
  affected INTEGER;
BEGIN
  WITH groups AS (
    SELECT
      monitor_job_id,
      telegram_id,
      MIN(id) AS keep_id,
      COUNT(*) AS group_size,
      SUM(message_count) AS total_msg,
      MIN(first_seen_at) AS first_seen,
      MAX(last_seen_at)  AS last_seen
    FROM scrape_monitor_users
    WHERE dedup_locked = TRUE
      AND monitor_chat_id IS NULL
    GROUP BY monitor_job_id, telegram_id
    HAVING COUNT(*) > 1
  ),
  -- Roll forward the survivor's counters from the whole group.
  rolled AS (
    UPDATE scrape_monitor_users u
       SET message_count  = g.total_msg,
           first_seen_at  = g.first_seen,
           last_seen_at   = g.last_seen
      FROM groups g
     WHERE u.id = g.keep_id
    RETURNING u.id
  )
  -- Now delete every row in the group except the survivor.
  DELETE FROM scrape_monitor_users u
        USING groups g
        WHERE u.monitor_job_id = g.monitor_job_id
          AND u.telegram_id    = g.telegram_id
          AND u.id            <> g.keep_id
          AND u.dedup_locked   = TRUE
          AND u.monitor_chat_id IS NULL;

  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected > 0 THEN
    RAISE NOTICE 'migration_v29: collapsed % duplicate scrape_monitor_users rows', affected;
  END IF;
END$$;

-- 4. Job-level scraped_count reconciliation. Some operators have
--    looked at the inflated scraped_count column expecting it to match
--    the number of *distinct* users they see in the export. After we
--    collapsed dupes above, re-derive scraped_count from the surviving
--    rows so the UI matches the export.
UPDATE scrape_monitor_jobs j
   SET scraped_count = sub.cnt,
       updated_at = NOW()
  FROM (
    SELECT monitor_job_id, COUNT(*)::int AS cnt
      FROM scrape_monitor_users
     WHERE dedup_locked = TRUE
       AND monitor_chat_id IS NULL
     GROUP BY monitor_job_id
  ) sub
 WHERE j.id = sub.monitor_job_id
   AND COALESCE(j.dedup_enabled, TRUE) = TRUE
   AND j.scraped_count IS DISTINCT FROM sub.cnt;

-- 5. The partial UNIQUE that gives the legacy dedup path race-safe upserts.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_smusers_job_tg_dedup
  ON scrape_monitor_users(monitor_job_id, telegram_id)
  WHERE dedup_locked = TRUE
    AND monitor_chat_id IS NULL;

COMMENT ON INDEX uniq_smusers_job_tg_dedup IS
  'Partial UNIQUE for legacy (monitor_chat_id IS NULL) dedup-on rows. Lets _recordProfile use INSERT ... ON CONFLICT ... DO UPDATE atomically even when N sessions on the same chat all receive the same NewMessage event in parallel. Complements uniq_smusers_chat_tg (v28) which covers v2 jobs.';
