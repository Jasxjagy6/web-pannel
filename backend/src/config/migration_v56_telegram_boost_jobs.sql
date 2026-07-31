CREATE TABLE IF NOT EXISTS boost_jobs (
  id               BIGSERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  targets          JSONB NOT NULL DEFAULT '[]'::jsonb,
  status           VARCHAR(20) NOT NULL DEFAULT 'pending',
  total_sessions   INTEGER NOT NULL DEFAULT 0,
  processed_count  INTEGER NOT NULL DEFAULT 0,
  applied_count    INTEGER NOT NULL DEFAULT 0,
  failed_count     INTEGER NOT NULL DEFAULT 0,
  skipped_count    INTEGER NOT NULL DEFAULT 0,
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  CONSTRAINT boost_jobs_status_check
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled'))
);

CREATE TABLE IF NOT EXISTS boost_job_items (
  id                BIGSERIAL PRIMARY KEY,
  job_id            BIGINT NOT NULL REFERENCES boost_jobs(id) ON DELETE CASCADE,
  session_id        INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  session_label     TEXT NOT NULL,
  status            VARCHAR(20) NOT NULL DEFAULT 'pending',
  applied_count     INTEGER NOT NULL DEFAULT 0,
  available_slots   INTEGER NOT NULL DEFAULT 0,
  result            JSONB NOT NULL DEFAULT '{}'::jsonb,
  skip_reason       VARCHAR(80),
  error_message     TEXT,
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  CONSTRAINT boost_job_items_status_check
    CHECK (status IN ('pending', 'running', 'boosted', 'failed', 'skipped'))
);

CREATE INDEX IF NOT EXISTS idx_boost_jobs_user_created
  ON boost_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_boost_jobs_pending
  ON boost_jobs(status, created_at) WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS idx_boost_job_items_job
  ON boost_job_items(job_id, id);
