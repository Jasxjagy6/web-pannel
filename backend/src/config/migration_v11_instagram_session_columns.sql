-- =============================================================================
-- Migration v11 — Instagram-required session columns
-- =============================================================================
-- The Instagram provider (`backend/src/providers/instagram/sessions.js` and
-- `create.js`) writes to a few `sessions` columns that the legacy schema does
-- not have. This migration adds them so IG INSERT/UPDATE statements stop
-- failing silently. All statements are idempotent so re-running is safe.
-- =============================================================================

-- 1. session_string — encrypted plaintext session string. Telegram already
-- stores the encrypted blob in `session_file_path` on disk; for Instagram we
-- store the cookie/device JSON directly in the row to avoid extra disk I/O on
-- every restore.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS session_string TEXT;

-- 2. session_data — encrypted JSON blob for IG (cookies + device fingerprint).
-- Stored as TEXT so the existing `crypto.encrypt()` helper (which returns a
-- ":"-separated hex string) can write directly without base64.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS session_data TEXT;

-- 3. proxy_url — per-session proxy override (IG accounts often need a sticky
-- residential proxy to avoid checkpoint loops). NULL means "use the global
-- pool / no proxy", which is the existing behaviour.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS proxy_url TEXT;

-- 4. last_login / last_used — IG provider tracks these separately from
-- TG's `last_active`. last_login = most recent successful login or token
-- refresh; last_used = most recent API call (scrape / DM / heartbeat probe).
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS last_login TIMESTAMP,
  ADD COLUMN IF NOT EXISTS last_used  TIMESTAMP;

-- 5. updated_at — generic mtime. Backfill from created_at so existing rows
-- have a sensible value.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();

UPDATE sessions
   SET updated_at = COALESCE(last_active, created_at, NOW())
 WHERE updated_at IS NULL OR updated_at = '1970-01-01 00:00:00';

-- 6. Helpful index for the IG provider's heartbeat / restore sweeps. Selects
-- only the IG-platform rows that are currently logged in, ordered by
-- recency. Telegram's existing index covers the TG side.
CREATE INDEX IF NOT EXISTS idx_sessions_instagram_logged_in
  ON sessions(platform, is_logged_in, last_used DESC)
  WHERE platform = 'instagram';
