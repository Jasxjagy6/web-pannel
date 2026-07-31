-- Persisted live Telegram username validation jobs.
--
-- The worker copies source usernames into job items before processing, so the
-- job remains auditable/resumable even if the operator later edits or deletes
-- the source list. Valid results are written to a normal `lists` row and can
-- use the existing CSV/JSON/TXT exports.

CREATE TABLE IF NOT EXISTS username_validation_jobs (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_list_id      INTEGER REFERENCES lists(id) ON DELETE SET NULL,
  session_list_id     INTEGER REFERENCES session_lists(id) ON DELETE SET NULL,
  result_list_id      INTEGER REFERENCES lists(id) ON DELETE SET NULL,
  source_list_name    VARCHAR(255) NOT NULL,
  session_list_name   VARCHAR(255) NOT NULL,
  result_list_name    VARCHAR(255) NOT NULL,
  status              VARCHAR(20) NOT NULL DEFAULT 'pending',
  source_items_count  INTEGER NOT NULL DEFAULT 0,
  total_count         INTEGER NOT NULL DEFAULT 0,
  processed_count     INTEGER NOT NULL DEFAULT 0,
  valid_count         INTEGER NOT NULL DEFAULT 0,
  invalid_count       INTEGER NOT NULL DEFAULT 0,
  failed_count        INTEGER NOT NULL DEFAULT 0,
  skipped_count       INTEGER NOT NULL DEFAULT 0,
  ignored_count       INTEGER NOT NULL DEFAULT 0,
  duplicate_count     INTEGER NOT NULL DEFAULT 0,
  selected_sessions   JSONB NOT NULL DEFAULT '[]'::jsonb,
  retired_sessions    JSONB NOT NULL DEFAULT '[]'::jsonb,
  current_username    VARCHAR(100),
  current_session_id  INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  cancel_requested    BOOLEAN NOT NULL DEFAULT FALSE,
  error_message       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  last_progress_at    TIMESTAMPTZ,
  CONSTRAINT username_validation_jobs_status_check CHECK (
    status IN ('pending', 'running', 'completed', 'exhausted', 'cancelled', 'failed')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_username_validation_jobs_user_active
  ON username_validation_jobs(user_id)
  WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS idx_username_validation_jobs_user_created
  ON username_validation_jobs(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_username_validation_jobs_status_created
  ON username_validation_jobs(status, created_at ASC);

CREATE TABLE IF NOT EXISTS username_validation_items (
  id                    BIGSERIAL PRIMARY KEY,
  job_id                BIGINT NOT NULL REFERENCES username_validation_jobs(id) ON DELETE CASCADE,
  source_list_item_id   INTEGER REFERENCES list_items(id) ON DELETE SET NULL,
  result_list_item_id   INTEGER REFERENCES list_items(id) ON DELETE SET NULL,
  username              VARCHAR(100) NOT NULL,
  normalized_username   VARCHAR(100) NOT NULL,
  status                VARCHAR(20) NOT NULL DEFAULT 'pending',
  resolved_telegram_id  BIGINT,
  resolved_access_hash  BIGINT,
  resolved_username     VARCHAR(100),
  resolved_first_name   VARCHAR(100),
  resolved_last_name    VARCHAR(100),
  resolved_phone        VARCHAR(30),
  session_id            INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  attempts              INTEGER NOT NULL DEFAULT 0,
  error_code            VARCHAR(80),
  error_message         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at            TIMESTAMPTZ,
  finished_at           TIMESTAMPTZ,
  CONSTRAINT username_validation_items_status_check CHECK (
    status IN ('pending', 'running', 'valid', 'invalid', 'failed', 'skipped')
  ),
  UNIQUE(job_id, normalized_username)
);

CREATE INDEX IF NOT EXISTS idx_username_validation_items_job_status_id
  ON username_validation_items(job_id, status, id);
