-- =====================================================================
-- Migration v23 — Recurring group-message schedules
-- =====================================================================
-- Adds the `message_schedules` table backing the third tab on the
-- Messaging page ("Schedule"). Each row drives one recurring
-- bulk-groups job: pick sessions + groups + a message + an interval
-- (in minutes), and the in-process tick loop keeps re-dispatching the
-- same job after each completion until the operator cancels it.
--
-- The schedule itself never owns sending logic — every tick just
-- reuses `messageService.sendBulkToGroups` so the existing rate
-- limiting (`delayBetweenRounds`) and per-target logging in
-- `message_logs` keep working unchanged. The schedule's `last_job_id`
-- points at the latest dispatched `messaging_jobs` row so the UI can
-- link from a schedule to its current/most-recent run.
--
-- All statements are idempotent; safe to re-run on an upgraded DB.
-- =====================================================================

CREATE TABLE IF NOT EXISTS message_schedules (
  id                    SERIAL PRIMARY KEY,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Optional human label so the operator can tell schedules apart in
  -- the history view. Defaults to NULL (UI falls back to "Schedule #id").
  name                  VARCHAR(120),

  -- Snapshot of the selection used to dispatch each run. Stored as
  -- JSONB arrays so we don't need a join table for what is effectively
  -- a frozen selection — schedules with mutated session/group sets
  -- should be cancelled and re-created.
  --   session_ids: integer[] of `sessions.id`
  --   group_ids  : string[]  of @username / numeric / invite-link
  session_ids           JSONB NOT NULL,
  group_ids             JSONB NOT NULL,

  message               TEXT  NOT NULL,
  message_type          VARCHAR(20) NOT NULL DEFAULT 'text',

  -- Intra-job rate-limit knob, forwarded verbatim to
  -- `sendBulkToGroups` on every dispatch.
  delay_between_rounds  INTEGER NOT NULL DEFAULT 20
    CHECK (delay_between_rounds BETWEEN 0 AND 3600),

  -- "Wait N minutes after the previous run finished, then run again."
  -- The tick loop measures the gap from `messaging_jobs.completed_at`
  -- of the last dispatched job, so the cadence is always relative to
  -- completion (not to the schedule's own creation time).
  interval_minutes      INTEGER NOT NULL
    CHECK (interval_minutes BETWEEN 1 AND 10080),

  status                VARCHAR(20) NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'cancelled', 'completed', 'failed')),

  -- Bookkeeping.
  total_runs            INTEGER NOT NULL DEFAULT 0,
  last_job_id           INTEGER REFERENCES messaging_jobs(id) ON DELETE SET NULL,
  last_run_at           TIMESTAMP,
  last_error            TEXT,

  created_at            TIMESTAMP NOT NULL DEFAULT NOW(),
  cancelled_at          TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_message_schedules_user
  ON message_schedules(user_id, status, created_at DESC);

-- The tick loop only cares about rows in 'running' status; the
-- partial index keeps that scan cheap even with thousands of
-- finished schedules sitting in history.
CREATE INDEX IF NOT EXISTS idx_message_schedules_running_last_job
  ON message_schedules(last_job_id)
  WHERE status = 'running';
