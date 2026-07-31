-- Persist sessionless t.me link checks in the same history used by live
-- session username validation. Link jobs return immediately, then expose
-- pass/request progress through the existing polling API.

ALTER TABLE username_validation_jobs
  ADD COLUMN IF NOT EXISTS validation_method VARCHAR(20) NOT NULL DEFAULT 'session',
  ADD COLUMN IF NOT EXISTS current_pass INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_passes INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS pass_processed_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pass_total_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_requests INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS timed_out BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE username_validation_jobs
  DROP CONSTRAINT IF EXISTS username_validation_jobs_method_check;

ALTER TABLE username_validation_jobs
  ADD CONSTRAINT username_validation_jobs_method_check CHECK (
    validation_method IN ('session', 'link')
  );

CREATE INDEX IF NOT EXISTS idx_username_validation_jobs_method_status_created
  ON username_validation_jobs(validation_method, status, created_at ASC);
