-- migration_v46_failover_reply_tracking.sql
--
-- Two related features for the "send message through a list" flow:
--
--  1. Sequential multi-session failover sends. A new messaging_jobs
--     job_type = 'failover' walks the target list with ONE session at a
--     time. When Telegram limits that session (PEER_FLOOD / FLOOD_WAIT)
--     or refuses the peer for a mutual-contact reason
--     (USER_NOT_MUTUAL_CONTACT / privacy), the runner switches to the
--     next session and RESUMES from the exact target where it stopped.
--     "Target-side" errors (username/id not found, deactivated, …) skip
--     just that one target without rotating the session. All of that
--     progress state lives in messaging_jobs.platform_state (already a
--     JSONB column) so no new job columns are strictly required, but we
--     add a couple of convenience columns for cheap querying.
--
--  2. A 24-hour reply-tracking pass that launches automatically once a
--     send job finishes. It records, per recipient, which session
--     messaged them and whether they have replied (counted at most once
--     per user), refreshing as new inbound messages arrive.

-- ---------------------------------------------------------------------
-- messaging_jobs: convenience columns for the failover runner + the
-- follow-on reply-scan bookkeeping. All nullable / default-valued so the
-- migration is additive and safe to re-run.
-- ---------------------------------------------------------------------
ALTER TABLE messaging_jobs
  ADD COLUMN IF NOT EXISTS reply_tracking_status VARCHAR(20),
  ADD COLUMN IF NOT EXISTS reply_tracking_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reply_tracking_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reply_tracking_last_scan_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS replied_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN messaging_jobs.reply_tracking_status IS 'null | pending | scanning | completed | stopped';
COMMENT ON COLUMN messaging_jobs.reply_tracking_until IS 'End of the 24h reply-observation window';
COMMENT ON COLUMN messaging_jobs.replied_count IS 'Distinct recipients from this job who have replied at least once';

-- ---------------------------------------------------------------------
-- message_reply_tracking: one row per (job, recipient) that was actually
-- sent a message. The reply scanner updates `replied` / `replied_at`
-- when it sees an inbound message from that recipient after the send.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_reply_tracking (
  id            SERIAL PRIMARY KEY,
  job_id        INTEGER NOT NULL REFERENCES messaging_jobs(id) ON DELETE CASCADE,
  session_id    INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  -- The addressable target as the operator supplied it (numeric id,
  -- @username, or +phone) — matches message_logs.target_id shape.
  target_id     TEXT NOT NULL,
  -- Resolved numeric Telegram user id when known (filled in at send time
  -- or by the scanner) so inbound messages can be matched reliably even
  -- when the list only had a @username.
  peer_id       BIGINT,
  -- Best-effort display label for the UI (username / name).
  target_label  TEXT,
  -- The message we sent (for the "sent to user X" line in the UI).
  sent_status   VARCHAR(20) NOT NULL DEFAULT 'sent',
  sent_at       TIMESTAMPTZ,
  replied       BOOLEAN NOT NULL DEFAULT FALSE,
  replied_at    TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_mrt_job_id       ON message_reply_tracking(job_id);
CREATE INDEX IF NOT EXISTS idx_mrt_session_id   ON message_reply_tracking(session_id);
CREATE INDEX IF NOT EXISTS idx_mrt_job_replied  ON message_reply_tracking(job_id, replied);
CREATE INDEX IF NOT EXISTS idx_mrt_peer_id      ON message_reply_tracking(peer_id);

-- Index to let the reply-scan scheduler find jobs whose 24h window is
-- still open without a full table scan.
CREATE INDEX IF NOT EXISTS idx_messaging_jobs_reply_tracking
  ON messaging_jobs(reply_tracking_status, reply_tracking_until)
  WHERE reply_tracking_status IS NOT NULL;
