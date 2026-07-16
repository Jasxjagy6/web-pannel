-- migration_v44_tracking_session_sync.sql
--
-- Lets the Tracking panel auto-populate an account from a LOGGED-IN
-- Telegram session on the Telegram panel: profile, avatar, bio, privacy
-- settings, and the full list of active logins/authorizations. The data
-- is a stored snapshot — it persists on the tracking side even after the
-- session is later logged out or deleted (source_session_id goes NULL,
-- the tracking row and its synced data remain).
--
-- NOTE on secrets: Telegram's API never returns the plaintext 2FA
-- password or the full recovery email for a logged-in session — only a
-- hint and a masked pattern. Those masked values live here; the
-- plaintext 2FA/recovery (from the uploaded session-info JSON or manual
-- entry) stays in tracking_account_security (encrypted).

-- 1. Link tracking accounts back to their originating session + sync state
ALTER TABLE tracking_accounts
  ADD COLUMN IF NOT EXISTS source_session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_session_linked BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS session_synced_at TIMESTAMPTZ,
  -- Tiny stripped-thumbnail avatar (a few hundred bytes) for the list
  -- page; the larger detail avatar lives on telegram_meta.
  ADD COLUMN IF NOT EXISTS avatar_thumb TEXT;

CREATE INDEX IF NOT EXISTS idx_tracking_accounts_source_session ON tracking_accounts(source_session_id);

-- 2. Extra Telegram metadata captured from a live session
ALTER TABLE tracking_account_telegram_meta
  ADD COLUMN IF NOT EXISTS profile_photo_data TEXT,          -- small (~128px) avatar data URI, detail view
  ADD COLUMN IF NOT EXISTS privacy_settings JSONB,           -- { lastSeen, phoneNumber, profilePhoto, calls, groupsAndInvites, forwards, birthday, bio, voiceMessages: 'everybody'|'contacts'|'nobody'|... }
  ADD COLUMN IF NOT EXISTS two_fa_enabled_live BOOLEAN,      -- 2FA state reported by the live session (vs manual sim_info flag)
  ADD COLUMN IF NOT EXISTS two_fa_hint VARCHAR(255),         -- password hint from account.getPassword
  ADD COLUMN IF NOT EXISTS has_recovery_email BOOLEAN,       -- whether a recovery email is configured
  ADD COLUMN IF NOT EXISTS masked_recovery_email VARCHAR(255), -- masked pattern (e.g. j••••@g•••.com) — API never returns the full address
  ADD COLUMN IF NOT EXISTS lang_code VARCHAR(10),
  ADD COLUMN IF NOT EXISTS dc_id INTEGER,
  ADD COLUMN IF NOT EXISTS login_count INTEGER NOT NULL DEFAULT 0;

-- 3. Active logins / authorizations (one row per device session).
--    Replaced wholesale on each sync so it always mirrors the live list.
CREATE TABLE IF NOT EXISTS tracking_account_logins (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES tracking_accounts(id) ON DELETE CASCADE,
  auth_hash VARCHAR(40),
  device_model VARCHAR(200),
  platform VARCHAR(100),
  system_version VARCHAR(100),
  api_id INTEGER,
  app_name VARCHAR(100),
  app_version VARCHAR(100),
  official_app BOOLEAN,
  ip VARCHAR(64),
  country VARCHAR(100),
  region VARCHAR(100),
  is_current BOOLEAN NOT NULL DEFAULT FALSE,
  date_created TIMESTAMPTZ,
  date_active TIMESTAMPTZ,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tracking_account_logins_account_id ON tracking_account_logins(account_id);
