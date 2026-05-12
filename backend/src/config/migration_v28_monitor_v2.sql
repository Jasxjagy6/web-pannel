-- =====================================================================
-- Migration v28: Multi-Session Monitor V2 (institutional-grade passive
-- scraping for admin-only / hidden-member chats).
-- =====================================================================
--
-- Background
-- ----------
-- v6 added period-bounded passive monitoring (`scrape_monitor_jobs`,
-- `scrape_monitor_users`) for chats where Telegram refuses
-- `getParticipants` (`CHAT_ADMIN_REQUIRED`). That implementation parks
-- every selected session on ONE chat for the full window — a
-- behavioural fingerprint Telegram's spam server weights against, and
-- a hard cap of 1 chat per job.
--
-- v28 lifts both limits:
--   1. One job → many chats.            (scrape_monitor_chats)
--   2. Many sessions rotate per chat.   (scrape_monitor_shifts)
--   3. Per-(session,chat) fatigue ledger feeds the cohort planner.
--                                       (scrape_monitor_session_fatigue)
--
-- All changes are additive. Existing single-target monitor jobs keep
-- working: createJob is backwards-compatible and inserts a single
-- `scrape_monitor_chats` row per legacy call.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Per-chat children of a monitor job.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scrape_monitor_chats (
  id                BIGSERIAL PRIMARY KEY,
  monitor_job_id    INTEGER NOT NULL REFERENCES scrape_monitor_jobs(id) ON DELETE CASCADE,
  target_id         VARCHAR(255) NOT NULL,
  target_type       VARCHAR(20)  NOT NULL DEFAULT 'group',
  target_title      VARCHAR(255),
  -- 'open_roster' | 'admin_only' | 'unknown' (re-detected periodically)
  detected_mode     VARCHAR(20)  NOT NULL DEFAULT 'unknown',
  -- For 'open_roster' chats we also fire scrapeService once to grab
  -- the full visible roster, then a thin listening shift continues
  -- to capture new joiners through the window.
  fast_scrape_done  BOOLEAN      NOT NULL DEFAULT FALSE,
  fast_scrape_job_id INTEGER REFERENCES scraping_jobs(id) ON DELETE SET NULL,
  -- Desired concurrent listeners. Auto-sized by traffic (1/2/3 for
  -- cold/warm/hot chats) unless the operator pins it.
  cohort_size       INTEGER      NOT NULL DEFAULT 1,
  cohort_size_pinned BOOLEAN     NOT NULL DEFAULT FALSE,
  status            VARCHAR(20)  NOT NULL DEFAULT 'pending',
  -- Rolling traffic estimate used by the planner.
  events_per_minute_recent NUMERIC(10,2) DEFAULT 0,
  scraped_count     INTEGER      NOT NULL DEFAULT 0,
  events_observed   INTEGER      NOT NULL DEFAULT 0,
  handoff_miss_count INTEGER     NOT NULL DEFAULT 0,
  last_event_at     TIMESTAMP,
  last_detected_at  TIMESTAMP,
  created_at        TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP    NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE scrape_monitor_chats DROP CONSTRAINT IF EXISTS scrape_monitor_chats_status_check;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

ALTER TABLE scrape_monitor_chats
  ADD CONSTRAINT scrape_monitor_chats_status_check
  CHECK (status IN ('pending', 'running', 'paused', 'completed', 'cancelled', 'failed'));

CREATE INDEX IF NOT EXISTS idx_smchats_job
  ON scrape_monitor_chats(monitor_job_id);
CREATE INDEX IF NOT EXISTS idx_smchats_status
  ON scrape_monitor_chats(status);
CREATE INDEX IF NOT EXISTS idx_smchats_job_target
  ON scrape_monitor_chats(monitor_job_id, target_id);

-- ---------------------------------------------------------------------
-- 2. Per-shift listener assignments. The unit of work for the cohort
--    scheduler: one row per (chat × session × time window).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scrape_monitor_shifts (
  id                BIGSERIAL PRIMARY KEY,
  monitor_chat_id   BIGINT  NOT NULL REFERENCES scrape_monitor_chats(id) ON DELETE CASCADE,
  monitor_job_id    INTEGER NOT NULL REFERENCES scrape_monitor_jobs(id) ON DELETE CASCADE,
  session_id        INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  state             VARCHAR(20)  NOT NULL DEFAULT 'pending',
  planned_start     TIMESTAMP    NOT NULL,
  planned_end       TIMESTAMP    NOT NULL,
  actual_start      TIMESTAMP,
  actual_end        TIMESTAMP,
  events_observed   INTEGER      NOT NULL DEFAULT 0,
  users_credited    INTEGER      NOT NULL DEFAULT 0,
  fail_reason       TEXT,
  -- For ops forensics: which worker process claimed this shift.
  worker_id         VARCHAR(64),
  -- sessionOwnershipLock fencing token. Lets the orchestrator detect
  -- stale claims after a worker crashes.
  fencing_token     VARCHAR(128),
  -- The planner's reason string ("low fatigue, DC4 match, ..."). Stored
  -- so the operator UI can render the audit trail.
  plan_reason       TEXT,
  created_at        TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP    NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE scrape_monitor_shifts DROP CONSTRAINT IF EXISTS scrape_monitor_shifts_state_check;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

ALTER TABLE scrape_monitor_shifts
  ADD CONSTRAINT scrape_monitor_shifts_state_check
  CHECK (state IN (
    'pending', 'warming', 'active', 'handoff',
    'ended', 'failed', 'cancelled'
  ));

CREATE INDEX IF NOT EXISTS idx_smshifts_chat
  ON scrape_monitor_shifts(monitor_chat_id);
CREATE INDEX IF NOT EXISTS idx_smshifts_session
  ON scrape_monitor_shifts(session_id);
CREATE INDEX IF NOT EXISTS idx_smshifts_active
  ON scrape_monitor_shifts(state, planned_end)
  WHERE state IN ('warming','active','handoff');
CREATE INDEX IF NOT EXISTS idx_smshifts_job_state
  ON scrape_monitor_shifts(monitor_job_id, state);

-- Prevents the orchestrator's INSERT-on-tick from accidentally
-- double-booking the same (chat, session) pair at the same instant if
-- two ticker frames overlap (e.g. a slow query lets two ticks race).
-- planned_start is rounded to whole seconds in code so the conflict is
-- effective even if NOW() jitters by milliseconds.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_smshifts_chat_sess_start
  ON scrape_monitor_shifts(monitor_chat_id, session_id, planned_start);

-- ---------------------------------------------------------------------
-- 3. Rolling per-(session, target) fatigue ledger. The planner sums
--    the last N hourly buckets to compute the session's fatigue for a
--    given chat. Keeping it bucketed (rather than one growing row)
--    keeps writes append-mostly and lets us prune cheaply.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scrape_monitor_session_fatigue (
  session_id        INTEGER     NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  target_id         VARCHAR(255) NOT NULL,
  window_start      TIMESTAMP   NOT NULL,
  events_observed   INTEGER     NOT NULL DEFAULT 0,
  active_seconds    INTEGER     NOT NULL DEFAULT 0,
  flood_waits       INTEGER     NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, target_id, window_start)
);

CREATE INDEX IF NOT EXISTS idx_smfatigue_session_window
  ON scrape_monitor_session_fatigue(session_id, window_start DESC);
CREATE INDEX IF NOT EXISTS idx_smfatigue_target_window
  ON scrape_monitor_session_fatigue(target_id, window_start DESC);

-- ---------------------------------------------------------------------
-- 4. Additive columns on scrape_monitor_jobs for V2 job-level policy.
-- ---------------------------------------------------------------------
ALTER TABLE scrape_monitor_jobs
  ADD COLUMN IF NOT EXISTS cohort_size_default INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS shift_min_seconds   INTEGER NOT NULL DEFAULT 1800,   -- 30 min
  ADD COLUMN IF NOT EXISTS shift_max_seconds   INTEGER NOT NULL DEFAULT 5400,   -- 90 min
  ADD COLUMN IF NOT EXISTS overlap_seconds     INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS auto_fast_scrape    BOOLEAN NOT NULL DEFAULT TRUE,
  -- 'legacy' (v6 single-chat single-attach) or 'v2' (cohort scheduler).
  ADD COLUMN IF NOT EXISTS scheduler_version   VARCHAR(20) NOT NULL DEFAULT 'legacy';

-- ---------------------------------------------------------------------
-- 5. Link scraped_monitor_users to a specific chat-child so a multi-
--    chat job can be split per chat in exports. NULL means "legacy
--    single-chat job, the chat is implicit via monitor_job_id".
-- ---------------------------------------------------------------------
ALTER TABLE scrape_monitor_users
  ADD COLUMN IF NOT EXISTS monitor_chat_id BIGINT
    REFERENCES scrape_monitor_chats(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_smusers_chat
  ON scrape_monitor_users(monitor_chat_id, last_seen_at DESC);

-- Partial UNIQUE index: every V2 monitor row carries a monitor_chat_id
-- and must be unique per (chat, tg_id) at the DB layer so the
-- observationFunnel's ON CONFLICT DO NOTHING upsert is race-safe even
-- when Redis dedup falls open. Legacy rows with monitor_chat_id IS NULL
-- coexist freely since the partial WHERE excludes them.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_smusers_chat_tg
  ON scrape_monitor_users(monitor_chat_id, telegram_id)
  WHERE monitor_chat_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- Documentation
-- ---------------------------------------------------------------------
COMMENT ON TABLE  scrape_monitor_chats IS
  'One row per chat inside a monitor job. v28: lifts the single-chat-per-job limit imposed by v6.';
COMMENT ON COLUMN scrape_monitor_chats.detected_mode IS
  'open_roster (fast getParticipants OK) | admin_only (must monitor) | unknown (not yet probed). Refreshed every 6h while the job runs.';
COMMENT ON COLUMN scrape_monitor_chats.cohort_size IS
  'Number of sessions simultaneously listening to this chat. Auto-sized by traffic (1=cold, 2=warm, 3=hot) unless cohort_size_pinned=true.';

COMMENT ON TABLE  scrape_monitor_shifts IS
  'Per-(chat, session, time-window) listener assignments. The unit of work for the cohort scheduler.';
COMMENT ON COLUMN scrape_monitor_shifts.state IS
  'pending → warming → active → handoff → ended; failed/cancelled on error/cancel.';
COMMENT ON COLUMN scrape_monitor_shifts.plan_reason IS
  'Human-readable audit string from cohortPlanner explaining why this session was picked for this shift.';

COMMENT ON TABLE  scrape_monitor_session_fatigue IS
  'Rolling hourly ledger of per-(session, target) events + active_seconds. Feeds cohortPlanner fatigue scoring.';

COMMENT ON COLUMN scrape_monitor_jobs.scheduler_version IS
  'legacy = v6 single-attach. v2 = cohort scheduler (rotation, overlap, fatigue-aware). New jobs default to legacy for backwards-compat; v2 jobs are created via the multi-chat code path.';
