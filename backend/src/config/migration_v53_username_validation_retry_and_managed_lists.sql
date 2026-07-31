-- Multi-list username validation, one-time FLOOD_WAIT retry, and managed
-- SpamBot-status session lists.

ALTER TABLE username_validation_jobs
  ADD COLUMN IF NOT EXISTS session_list_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS session_list_names JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS retry_after_flood_wait BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS retry_pass_used BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS retry_at TIMESTAMPTZ;

UPDATE username_validation_jobs
   SET session_list_ids = jsonb_build_array(session_list_id)
 WHERE session_list_id IS NOT NULL
   AND session_list_ids = '[]'::jsonb;

UPDATE username_validation_jobs
   SET session_list_names = jsonb_build_array(session_list_name)
 WHERE session_list_name IS NOT NULL
   AND session_list_names = '[]'::jsonb;

ALTER TABLE username_validation_jobs
  DROP CONSTRAINT IF EXISTS username_validation_jobs_status_check;

ALTER TABLE username_validation_jobs
  ADD CONSTRAINT username_validation_jobs_status_check CHECK (
    status IN ('pending', 'running', 'waiting', 'completed', 'exhausted', 'cancelled', 'failed')
  );

DROP INDEX IF EXISTS uq_username_validation_jobs_user_active;

CREATE UNIQUE INDEX uq_username_validation_jobs_user_active
  ON username_validation_jobs(user_id)
  WHERE status IN ('pending', 'running', 'waiting');

CREATE INDEX IF NOT EXISTS idx_username_validation_jobs_waiting_retry
  ON username_validation_jobs(retry_at)
  WHERE status = 'waiting';

ALTER TABLE session_lists
  ADD COLUMN IF NOT EXISTS system_key VARCHAR(80);

CREATE UNIQUE INDEX IF NOT EXISTS uq_session_lists_user_platform_system_key
  ON session_lists(user_id, platform, system_key)
  WHERE system_key IS NOT NULL;
