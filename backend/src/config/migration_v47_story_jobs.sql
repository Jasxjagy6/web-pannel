-- migration_v47_story_jobs.sql
--
-- "Upload Story" feature (Account Settings). One background job uploads a
-- single photo/video (with optional caption + link) as a Telegram Story to
-- every selected session that is Premium (Stories are Premium-only). The
-- worker checks stories.CanSendStory per session and skips non-Premium /
-- ineligible accounts instead of failing them.
--
-- Mirrors the privacy_jobs / privacy_job_items job+items+history pattern so
-- the existing worker/polling/cancel/history conventions carry over.

-- ---------------------------------------------------------------------
-- story_jobs: one row per "upload this story to these sessions" request.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS story_jobs (
  id               BIGSERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Absolute on-disk path of the uploaded media (under the panel tmp
  -- uploads dir). Removed by the worker once the job finalizes.
  media_path       TEXT NOT NULL,
  -- 'photo' | 'video' — decides InputMediaUploadedPhoto vs Document.
  media_type       VARCHAR(10) NOT NULL,
  media_name       TEXT,
  -- Optional caption text and a single optional link. The link is appended
  -- to the caption at send time and surfaced as a message entity so it is
  -- tappable in the story.
  caption          TEXT,
  link_url         TEXT,
  -- Story visibility: 'everyone' | 'contacts' | 'close_friends'. Maps to
  -- Telegram InputPrivacyRule* at send time.
  privacy          VARCHAR(20) NOT NULL DEFAULT 'everyone',
  -- Story lifetime in seconds (Telegram allows 6h/12h/24h/48h). Default 24h.
  period_seconds   INTEGER NOT NULL DEFAULT 86400,
  -- Pin to the profile after it expires (Telegram "keep on my page").
  pin_to_profile   BOOLEAN NOT NULL DEFAULT FALSE,
  status           VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending|running|completed|failed|cancelled
  total_sessions   INTEGER NOT NULL DEFAULT 0,
  succeeded_count  INTEGER NOT NULL DEFAULT 0,
  failed_count     INTEGER NOT NULL DEFAULT 0,
  skipped_count    INTEGER NOT NULL DEFAULT 0, -- non-premium / can't-send accounts
  error_message    TEXT,
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_story_jobs_user_recent
  ON story_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_story_jobs_status
  ON story_jobs(status) WHERE status IN ('pending', 'running');

-- ---------------------------------------------------------------------
-- story_job_items: one row per (job, session). Records whether the story
-- was posted, skipped (not premium / can't send), or failed.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS story_job_items (
  id            BIGSERIAL PRIMARY KEY,
  job_id        BIGINT NOT NULL REFERENCES story_jobs(id) ON DELETE CASCADE,
  session_id    INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  -- Snapshot for the history UI so a later session rename/delete still
  -- shows what was targeted.
  phone         TEXT,
  session_label TEXT,
  -- pending | posted | skipped | failed
  status        VARCHAR(20) NOT NULL DEFAULT 'pending',
  -- 'not_premium' | 'cannot_send' | 'send_failed' | 'not_connected' | null
  skip_reason   VARCHAR(40),
  -- Telegram story id when posted (for reference / dedup).
  story_id      BIGINT,
  error_message TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  UNIQUE (job_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_story_job_items_job
  ON story_job_items(job_id, status);
CREATE INDEX IF NOT EXISTS idx_story_job_items_session
  ON story_job_items(session_id);
