-- Migration v6: channel monitoring jobs
-- Idempotent — safe to run on every boot.

-- Annotate scraping_jobs with admin-only-visible detection so the UI
-- can offer a follow-up monitoring job for groups/channels that don't
-- expose a participant list.
ALTER TABLE scraping_jobs
  ADD COLUMN IF NOT EXISTS admin_only_visible BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE scraping_jobs
  ADD COLUMN IF NOT EXISTS admin_only_reason VARCHAR(120);

-- Long-running monitoring job. One job watches one chat with one or more
-- sessions, polls history on a jittered tick, and drops senders into
-- monitoring_users with strict deduplication.
CREATE TABLE IF NOT EXISTS monitoring_jobs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scraping_job_id INTEGER REFERENCES scraping_jobs(id) ON DELETE SET NULL,
  -- The chat we're monitoring. Stored as raw input + resolved Telegram ids
  -- so the worker can keep going even if the input link is later edited.
  target VARCHAR(512) NOT NULL,
  target_type VARCHAR(20),                 -- 'group' | 'channel' | 'megagroup'
  target_id VARCHAR(50),                   -- numeric Telegram chat id
  target_access_hash VARCHAR(50),
  target_title VARCHAR(255),
  -- Scheduling.
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds > 0),
  started_at TIMESTAMP,
  ends_at TIMESTAMP,
  paused_at TIMESTAMP,
  pause_remaining_seconds INTEGER,         -- captured at pause time
  -- Sessions used to poll. Round-robin'd by the worker. Null/empty until
  -- the job is started. Kept as integer[] for cheap ANY() queries.
  session_ids INTEGER[] NOT NULL DEFAULT '{}',
  current_session_idx INTEGER NOT NULL DEFAULT 0,
  -- Polling cursor.
  last_offset_id BIGINT NOT NULL DEFAULT 0,
  next_poll_at TIMESTAMP NOT NULL DEFAULT NOW(),
  -- Counters.
  scraped_count INTEGER NOT NULL DEFAULT 0,
  ticks_completed INTEGER NOT NULL DEFAULT 0,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  -- Lifecycle.
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'paused', 'completed', 'cancelled', 'error')),
  last_error TEXT,
  options JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_monitoring_jobs_user_id
  ON monitoring_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_monitoring_jobs_status
  ON monitoring_jobs(status);
-- The worker's hot path: pull running jobs whose next_poll_at has come.
CREATE INDEX IF NOT EXISTS idx_monitoring_jobs_due
  ON monitoring_jobs(status, next_poll_at)
  WHERE status = 'running';

-- Per-job, per-user dedup. (job_id, telegram_user_id) is unique so duplicate
-- senders get silently rejected by the ON CONFLICT path in the worker.
CREATE TABLE IF NOT EXISTS monitoring_users (
  id SERIAL PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES monitoring_jobs(id) ON DELETE CASCADE,
  telegram_id BIGINT NOT NULL,
  username VARCHAR(100),
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  phone VARCHAR(20),
  is_premium BOOLEAN,
  is_bot BOOLEAN,
  -- The way we discovered them.
  source VARCHAR(20) NOT NULL DEFAULT 'message',  -- 'message' | 'reaction' | 'reply'
  message_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_message_id BIGINT,
  last_message_text TEXT,
  raw JSONB,
  CONSTRAINT monitoring_users_dedup UNIQUE (job_id, telegram_id)
);
CREATE INDEX IF NOT EXISTS idx_monitoring_users_job
  ON monitoring_users(job_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_monitoring_users_username
  ON monitoring_users(job_id, username);
