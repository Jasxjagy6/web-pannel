-- =============================================================================
-- Migration v9.2 — Instagram-specific extras
-- =============================================================================
-- Tables and columns that exist purely for the Instagram panel and have no
-- Telegram analog. The platform foundation (enum, platform columns,
-- per-platform billing seeds) is already in place from v9_multiplatform.sql.
--
-- All statements are idempotent so re-running the migration is safe.
-- =============================================================================

-- 1. sessions.platform_state — generic per-platform JSON blob -----------------
-- IG uses this to persist:
--   • the device fingerprint blob (deviceId/uuid/adid/buildVer/...) so the
--     same fingerprint is reused on every login from this session,
--   • warmup counters (daily_sent, hourly_sent, lifetime_sent, last_reset_at)
--     so the messaging worker can enforce per-account caps,
--   • the most recent challenge URL / two_factor_identifier returned by
--     instagram-private-api so a follow-up `/create/password` call can
--     submit the OTP without re-entering the username/password.
--
-- TG can use the same column for, e.g., DC migration state if we ever want
-- it, but it stays NULL for existing TG sessions.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS platform_state JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_sessions_platform_state_warmup
  ON sessions ((platform_state->'warmup'->>'last_reset_at'));

-- 2. ig_threads — DM thread cache --------------------------------------------
-- A thread is identified by Instagram's own thread_id (string). One row per
-- (session, thread_id). Stored separately from the legacy `groups` table
-- because IG threads have very different semantics (multi-participant DMs,
-- not channels/supergroups) and we want a clean schema.
CREATE TABLE IF NOT EXISTS ig_threads (
  id BIGSERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id VARCHAR(64) NOT NULL,
  thread_title VARCHAR(255),
  participant_count INTEGER NOT NULL DEFAULT 0,
  participants JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_activity_at TIMESTAMP,
  is_group BOOLEAN NOT NULL DEFAULT FALSE,
  is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
  is_muted BOOLEAN NOT NULL DEFAULT FALSE,
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_seen_message_id VARCHAR(64),
  raw_metadata JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, thread_id)
);

CREATE INDEX IF NOT EXISTS idx_ig_threads_user_active
  ON ig_threads(user_id, last_activity_at DESC);

CREATE INDEX IF NOT EXISTS idx_ig_threads_session_active
  ON ig_threads(session_id, last_activity_at DESC);

-- 3. ig_thread_messages — per-thread message cache ----------------------------
-- We only cache the most-recent N messages per thread (the messaging worker
-- evicts older rows). Used by the Threads page to render conversation history
-- without round-tripping the IG API on every keystroke.
CREATE TABLE IF NOT EXISTS ig_thread_messages (
  id BIGSERIAL PRIMARY KEY,
  thread_id VARCHAR(64) NOT NULL,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ig_message_id VARCHAR(64) NOT NULL,
  ig_user_pk BIGINT,
  direction VARCHAR(10) NOT NULL,        -- 'in' | 'out'
  message_type VARCHAR(32) NOT NULL,     -- 'text' | 'media' | 'reel_share' | ...
  text TEXT,
  media JSONB,
  reply_to_message_id VARCHAR(64),
  sent_at TIMESTAMP,
  raw JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, thread_id, ig_message_id)
);

CREATE INDEX IF NOT EXISTS idx_ig_thread_messages_thread_sent
  ON ig_thread_messages(thread_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_ig_thread_messages_user_sent
  ON ig_thread_messages(user_id, sent_at DESC);

-- 4. ig_warmup_history — append-only audit of warmup throttle decisions -------
-- Helps debugging "why didn't my account send" reports and lets us surface a
-- per-day chart in the Instagram Dashboard.
CREATE TABLE IF NOT EXISTS ig_warmup_history (
  id BIGSERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  hour INTEGER NOT NULL,
  decision VARCHAR(16) NOT NULL,         -- 'sent' | 'capped_daily' | 'capped_hourly' | 'paused_warmup'
  daily_sent INTEGER NOT NULL DEFAULT 0,
  daily_cap INTEGER NOT NULL DEFAULT 0,
  hourly_sent INTEGER NOT NULL DEFAULT 0,
  hourly_cap INTEGER NOT NULL DEFAULT 0,
  recorded_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ig_warmup_history_session_date
  ON ig_warmup_history(session_id, date);

-- 5. ig_challenges — short-lived login challenge state ------------------------
-- Instagram's private API forces the user through a SMS / email challenge on
-- new devices. Each challenge has a one-shot URL that we have to remember
-- between the first /create/start and the follow-up /create/password call.
-- A row is inserted when the API returns a `challenge_required` error and
-- removed (or marked resolved=true) once the user submits the code.
CREATE TABLE IF NOT EXISTS ig_challenges (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username VARCHAR(150) NOT NULL,
  challenge_url TEXT NOT NULL,
  challenge_type VARCHAR(20),              -- 'sms' | 'email' | null
  two_factor_identifier VARCHAR(255),
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL DEFAULT NOW() + INTERVAL '15 minutes'
);

CREATE INDEX IF NOT EXISTS idx_ig_challenges_user_open
  ON ig_challenges(user_id, resolved, expires_at DESC);

-- 6. messaging_jobs.platform_state -------------------------------------------
-- Per-job per-platform overrides (warmup caps, gif/photo media specs).
-- Stays NULL for TG.
ALTER TABLE messaging_jobs
  ADD COLUMN IF NOT EXISTS platform_state JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 7. scraped_users.thumbnail_url ---------------------------------------------
-- IG profile thumbnails so the frontend can render a Story-style ring
-- around scraped users in the lists view.
ALTER TABLE scraped_users
  ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;

-- 8. Seeds for IG-only system_settings ---------------------------------------
INSERT INTO system_settings (key, value, updated_at) VALUES
  ('messaging.instagram.send_jitter_ms_min',   '4000'::jsonb,  NOW()),
  ('messaging.instagram.send_jitter_ms_max',   '12000'::jsonb, NOW()),
  ('messaging.instagram.warmup_daily_caps',
    '[5, 8, 12, 16, 22, 28, 30]'::jsonb, NOW()),
  ('scrape.instagram.followers_page_size',     '200'::jsonb,   NOW()),
  ('scrape.instagram.following_page_size',     '200'::jsonb,   NOW()),
  ('scrape.instagram.likers_page_size',        '500'::jsonb,   NOW()),
  ('proxies.instagram.validate_endpoint',
    '"https://i.instagram.com/api/v1/users/web_profile_info/?username=instagram"'::jsonb, NOW())
ON CONFLICT (key) DO NOTHING;
