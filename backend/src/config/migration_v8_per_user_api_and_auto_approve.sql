-- =====================================================================
-- Migration v8: Drop admin-approval gate + per-user Telegram API credentials
-- =====================================================================
-- Two changes that ship together:
--
--   1. Auto-approve all newly-registered users. The "wait for an admin
--      to flip you to approved" step is removed. The flow is now
--      register -> /billing -> trial or pay -> use the panel.
--
--      We update the column DEFAULTs and backfill any existing users
--      that were stuck in `pending` so they can keep using the panel
--      without waiting on a now-removed admin action. Admins can still
--      ban a user; that path is unchanged.
--
--   2. Each user can now register one or more Telegram API ID / Hash
--      credentials in Settings. Every session this user creates / loads
--      MUST be tied to one of those credentials. We add:
--
--        * `user_api_credentials` — credential vault (encrypted hash)
--        * `sessions.user_api_credential_id` — which credential a
--          session uses, so we can rotate sessions across creds and
--          enforce a per-credential `max_sessions` cap.
--
--      Selection logic lives in the application (see
--      backend/src/services/userApiCredentialsService.js) so this
--      migration is purely structural.
--
-- All statements are idempotent — safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Auto-approve: change defaults + backfill existing pending users.
-- ---------------------------------------------------------------------
ALTER TABLE users
  ALTER COLUMN status SET DEFAULT 'approved';

ALTER TABLE users
  ALTER COLUMN is_approved SET DEFAULT TRUE;

-- Promote any user that was stuck in `pending` waiting on the now-
-- removed admin approval. Banned users are explicitly preserved.
UPDATE users
   SET status = 'approved',
       is_approved = TRUE,
       approved_at = COALESCE(approved_at, NOW()),
       updated_at = NOW()
 WHERE status = 'pending';

-- ---------------------------------------------------------------------
-- 2. user_api_credentials — per-user encrypted Telegram API ID / Hash
--    vault. `api_hash_enc` is encrypted with the same AES-GCM helper
--    used for session strings. `max_sessions` is the per-credential
--    rotation cap; pickForNewSession() in the service refuses to bind
--    a new session once `live_session_count >= max_sessions`.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_api_credentials (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label           VARCHAR(100),
  api_id          BIGINT  NOT NULL,
  api_hash_enc    TEXT    NOT NULL,
  max_sessions    INTEGER NOT NULL DEFAULT 3
                  CHECK (max_sessions BETWEEN 1 AND 50),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  notes           TEXT,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMP
);

-- Same user cannot store the same api_id twice (live or "soft-deleted
-- but later restored" doesn't matter — deleting hard-deletes).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_user_api_creds_user_apiid
  ON user_api_credentials(user_id, api_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_user_api_creds_user
  ON user_api_credentials(user_id)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------
-- 3. sessions.user_api_credential_id — bind every session to the cred
--    that minted it so the rotation cap can be enforced cheaply with
--    a COUNT(*) per credential.
-- ---------------------------------------------------------------------
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS user_api_credential_id INTEGER
    REFERENCES user_api_credentials(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_credential
  ON sessions(user_api_credential_id);

-- ---------------------------------------------------------------------
-- 4. Hot-path indexes for the 500–700 concurrent user target.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_sessions_user_logged_in
  ON sessions(user_id, is_logged_in);

CREATE INDEX IF NOT EXISTS idx_scrape_monitor_user_status
  ON scrape_monitor_jobs(user_id, status);

CREATE INDEX IF NOT EXISTS idx_scraping_jobs_user_status
  ON scraping_jobs(user_id, status);

CREATE INDEX IF NOT EXISTS idx_messaging_jobs_user_status
  ON messaging_jobs(user_id, status);

-- ---------------------------------------------------------------------
-- Documentation
-- ---------------------------------------------------------------------
COMMENT ON TABLE  user_api_credentials             IS 'Per-user Telegram API ID/Hash vault used for all that user''s sessions. api_hash_enc is AES-GCM encrypted.';
COMMENT ON COLUMN user_api_credentials.max_sessions IS 'How many sessions can be bound to this credential at once. The session rotation logic refuses to mint a new session past this cap to avoid Telegram suspicious-activity detection.';
COMMENT ON COLUMN sessions.user_api_credential_id   IS 'The user_api_credentials row this session was minted from. NULL only for legacy sessions created before migration v8.';
