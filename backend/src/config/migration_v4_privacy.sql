-- migration_v4_privacy.sql
-- Privacy bulk-set feature
--
-- Stores user-submitted "set privacy on these N sessions" jobs and their
-- per-session results. The job row carries the same {key -> rule}
-- mapping that the user picked in the panel; the items table tracks the
-- outcome on each individual Telegram session including the MTProto
-- error code on failure (FLOOD_WAIT, PRIVACY_KEY_INVALID, etc.) so the
-- UI can render a useful drilldown.

-- ---------------------------------------------------------------------
-- privacy_jobs
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS privacy_jobs (
  id              BIGSERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- {phone_number: 'contacts', last_seen: 'everybody', ...}
  settings        JSONB   NOT NULL,
  -- pending | running | completed | failed | cancelled
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  total_sessions  INTEGER NOT NULL DEFAULT 0,
  succeeded_count INTEGER NOT NULL DEFAULT 0,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  skipped_count   INTEGER NOT NULL DEFAULT 0,
  error_message   TEXT,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMP,
  finished_at     TIMESTAMP,
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_privacy_jobs_user_recent
  ON privacy_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_privacy_jobs_status
  ON privacy_jobs(status) WHERE status IN ('pending','running');

-- ---------------------------------------------------------------------
-- privacy_job_items
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS privacy_job_items (
  id              BIGSERIAL PRIMARY KEY,
  job_id          BIGINT  NOT NULL REFERENCES privacy_jobs(id) ON DELETE CASCADE,
  session_id      INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  -- pending | running | succeeded | failed | skipped
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  -- per-key outcome breakdown ({phone_number: 'ok', last_seen: 'FLOOD_WAIT_42'})
  results         JSONB,
  error_code      VARCHAR(64),
  error_message   TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  started_at      TIMESTAMP,
  finished_at     TIMESTAMP,
  UNIQUE (job_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_privacy_job_items_job
  ON privacy_job_items(job_id, status);
CREATE INDEX IF NOT EXISTS idx_privacy_job_items_session
  ON privacy_job_items(session_id);
