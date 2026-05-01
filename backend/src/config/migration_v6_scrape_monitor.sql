-- =====================================================================
-- Migration v6: Period-bounded scrape MONITOR jobs (admin-only chats)
-- =====================================================================
-- When a Telegram chat is "admin-only" (the panel session is not an
-- admin and Telegram refuses GetParticipants/CHAT_ADMIN_REQUIRED, or
-- canViewParticipants is false), we cannot scrape the member roster
-- directly. Instead the user can opt to MONITOR the chat for a given
-- period (e.g. 2 days). We attach a passive NewMessage handler to each
-- selected session and persist every distinct user we see interact in
-- that chat during the window.
--
-- Tables:
--   * scrape_monitor_jobs    - one row per monitor job (period, status,
--                              counters, owner, sessions, target).
--   * scrape_monitor_users   - distinct user that we observed inside
--                              the chat. UNIQUE(monitor_job_id, telegram_id)
--                              gives us free dedup.
--
-- All statements are idempotent.
-- =====================================================================

CREATE TABLE IF NOT EXISTS scrape_monitor_jobs (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_ids     INTEGER[]    NOT NULL DEFAULT '{}',
  target_id       VARCHAR(255) NOT NULL,
  target_type     VARCHAR(20)  NOT NULL DEFAULT 'group',
  target_title    VARCHAR(255),
  status          VARCHAR(20)  NOT NULL DEFAULT 'pending',
  duration_seconds INTEGER     NOT NULL,
  remaining_seconds INTEGER,
  scraped_count   INTEGER      NOT NULL DEFAULT 0,
  options         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  reason          TEXT,
  started_at      TIMESTAMP,
  paused_at       TIMESTAMP,
  expires_at      TIMESTAMP,
  completed_at    TIMESTAMP,
  created_at      TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP    NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE scrape_monitor_jobs DROP CONSTRAINT IF EXISTS scrape_monitor_jobs_status_check;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

ALTER TABLE scrape_monitor_jobs
  ADD CONSTRAINT scrape_monitor_jobs_status_check
  CHECK (status IN ('pending', 'running', 'paused', 'completed', 'cancelled', 'failed'));

CREATE INDEX IF NOT EXISTS idx_scrape_monitor_user
  ON scrape_monitor_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scrape_monitor_status
  ON scrape_monitor_jobs(status);
CREATE INDEX IF NOT EXISTS idx_scrape_monitor_expires
  ON scrape_monitor_jobs(expires_at) WHERE status = 'running';

-- ----------------------------------------------------------------------
-- Distinct users observed during a monitor window. UNIQUE constraint is
-- the dedup primitive: we just `INSERT ... ON CONFLICT DO UPDATE` to
-- bump message_count and last_seen_at without ever inserting a
-- duplicate row.
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scrape_monitor_users (
  id              BIGSERIAL PRIMARY KEY,
  monitor_job_id  INTEGER NOT NULL REFERENCES scrape_monitor_jobs(id) ON DELETE CASCADE,
  telegram_id     BIGINT  NOT NULL,
  username        VARCHAR(255),
  first_name      VARCHAR(255),
  last_name       VARCHAR(255),
  phone           VARCHAR(64),
  is_bot          BOOLEAN NOT NULL DEFAULT FALSE,
  is_premium      BOOLEAN NOT NULL DEFAULT FALSE,
  message_count   INTEGER NOT NULL DEFAULT 1,
  first_seen_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  via_session_id  INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  UNIQUE(monitor_job_id, telegram_id)
);

CREATE INDEX IF NOT EXISTS idx_scrape_monitor_users_job
  ON scrape_monitor_users(monitor_job_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_scrape_monitor_users_tg
  ON scrape_monitor_users(telegram_id);

-- Comments / documentation
COMMENT ON TABLE  scrape_monitor_jobs  IS 'Period-bounded passive monitors used when a chat is admin-only and member scraping is denied.';
COMMENT ON COLUMN scrape_monitor_jobs.duration_seconds  IS 'Total monitor window in seconds (e.g. 172800 for 2 days).';
COMMENT ON COLUMN scrape_monitor_jobs.remaining_seconds IS 'Remaining window when paused; on resume we recompute expires_at = NOW() + remaining_seconds.';
COMMENT ON COLUMN scrape_monitor_jobs.session_ids       IS 'Sessions whose Telegram clients are listening to NewMessage in target_id.';
COMMENT ON TABLE  scrape_monitor_users IS 'Distinct users observed interacting in the monitored chat. UNIQUE(monitor_job_id, telegram_id) gives free deduplication.';
