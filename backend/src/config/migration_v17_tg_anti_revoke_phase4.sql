-- =============================================================================
-- migration_v17_tg_anti_revoke_phase4.sql
--
-- Anti-revoke Phase 4 — bulletproof panel sessions.
--
-- The earlier phases (v13) added DC pinning, MTProto-Ping keepalive,
-- presence broadcasting, and a periodic GetAuthorizations probe. Phase 4
-- closes the remaining holes that allowed Telegram to wipe a panel
-- session under user-side actions ("Terminate all other sessions",
-- account TTL expiry, transient-error false-positives):
--
--   1. tg_session_health gets columns to track:
--        - confirmed_at:                 last successful
--                                         account.ChangeAuthorizationSettings(
--                                           hash=0, confirmed=true) call.
--                                         NULL means we never confirmed
--                                         this session — it's still in
--                                         the 24h "unconfirmed" window
--                                         where any other login can
--                                         wipe it.
--        - account_ttl_set_at:           last time we called
--                                         account.SetAccountTTL(730d).
--                                         The account is auto-deleted
--                                         after this many days of
--                                         inactivity, so we re-up it
--                                         on every panel login.
--        - consecutive_revoke_signals:   number of permanent-auth
--                                         errors observed back-to-back.
--                                         A session is only marked
--                                         status='revoked' once this
--                                         crosses ANTI_REVOKE_PHASE_4_
--                                         CONSECUTIVE_REVOKE_THRESHOLD
--                                         (default 2) and the first
--                                         strike is older than
--                                         ANTI_REVOKE_PHASE_4_REVOKE_
--                                         CONFIRM_WINDOW_MS (default
--                                         30 min). Single-strike
--                                         transients no longer kill
--                                         the row.
--        - first_revoke_signal_at:       timestamp of the first strike
--                                         in the current consecutive
--                                         streak. Reset to NULL after
--                                         a successful ping.
--        - last_revoke_signal_code:      symbolic code of the most
--                                         recent strike (e.g. AUTH_KEY_
--                                         UNREGISTERED), kept for the
--                                         operator's post-mortem.
--        - consecutive_external_revoke_signals: same idea but for the
--                                         GetAuthorizations probe (the
--                                         "session disappeared from the
--                                         active-sessions list" path).
--                                         Same threshold + window.
--        - last_recovered_at:            last time POST /sessions/:id/
--                                         recover successfully restored
--                                         a row from its on-disk file.
--        - alert_chat_id:                Telegram chat ID to push the
--                                         "your panel session entered
--                                         the danger zone" DM to.
--                                         NULL = no push for this
--                                         session.
--        - last_alert_at / last_alert_kind: rate-limit + dedupe.
--
--   2. session_backups: a write-only ledger of every encrypted session
--      string the panel has ever held. Lets the operator restore from
--      a 7-/30-/90-day-old snapshot if a recent corruption / bad delete
--      happened. The backup payload is the same encrypted blob we
--      already write to <uploadDir>/<userId>/sessions/<uuid>.json, but
--      stored in a separate filesystem path (`backups/`) and indexed by
--      a SHA-256 fingerprint so identical bodies dedupe.
--
-- Idempotent: every CREATE / ALTER uses IF NOT EXISTS / IF EXISTS.
-- =============================================================================

-- 1. tg_session_health additions ---------------------------------------------
ALTER TABLE tg_session_health
  ADD COLUMN IF NOT EXISTS confirmed_at                       TIMESTAMP,
  ADD COLUMN IF NOT EXISTS account_ttl_set_at                 TIMESTAMP,
  ADD COLUMN IF NOT EXISTS consecutive_revoke_signals         INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_revoke_signal_at             TIMESTAMP,
  ADD COLUMN IF NOT EXISTS last_revoke_signal_code            VARCHAR(64),
  ADD COLUMN IF NOT EXISTS consecutive_external_revoke_signals INTEGER    NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_recovered_at                  TIMESTAMP,
  ADD COLUMN IF NOT EXISTS alert_chat_id                      VARCHAR(64),
  ADD COLUMN IF NOT EXISTS last_alert_at                      TIMESTAMP,
  ADD COLUMN IF NOT EXISTS last_alert_kind                    VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_tg_session_health_confirmed_at
  ON tg_session_health(confirmed_at);

CREATE INDEX IF NOT EXISTS idx_tg_session_health_streak
  ON tg_session_health(consecutive_revoke_signals)
  WHERE consecutive_revoke_signals > 0;

-- 2. session_backups -----------------------------------------------------
-- Lightweight ledger so deleting a session row doesn't immediately destroy
-- the only copy of the encrypted GramJS string. The backend writes one row
-- per (session, content-fingerprint) tuple every time the session string
-- is created or refreshed; old rows are retained for at least
-- ANTI_REVOKE_PHASE_4_BACKUP_RETENTION_DAYS (default 90).
CREATE TABLE IF NOT EXISTS session_backups (
  id              BIGSERIAL PRIMARY KEY,
  session_id      INTEGER NOT NULL,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  phone           VARCHAR(32),
  api_id          INTEGER,
  api_hash        VARCHAR(64),
  -- Hex-encoded SHA-256 of the encrypted payload — used to dedupe so
  -- identical session strings (e.g. the heartbeat just refreshed file
  -- mtime without rotating the auth_key) don't bloat this table.
  content_sha256  VARCHAR(64) NOT NULL,
  -- Path on disk relative to uploadDir, e.g.
  --   backups/123/45/abcdef0123-2026-05-04T12-00-00.enc
  -- Each backup file is a copy of the JSON payload from
  -- <uploadDir>/<userId>/sessions/<uuid>.json plus a small metadata
  -- header. They are encrypted with the same SESSION_ENCRYPTION_KEY as
  -- the live session files.
  backup_path     TEXT       NOT NULL,
  backup_bytes    INTEGER,
  reason          VARCHAR(32) NOT NULL DEFAULT 'created',
  -- Soft-delete: pruner sweeps rows where retain_until < NOW() and
  -- deletes the on-disk file before deleting the row.
  retain_until    TIMESTAMP NOT NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, content_sha256)
);

CREATE INDEX IF NOT EXISTS idx_session_backups_session_time
  ON session_backups(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_backups_user_time
  ON session_backups(user_id, created_at DESC)
  WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_session_backups_retain
  ON session_backups(retain_until);

-- 3. Backfill: tg_session_health row for every existing telegram session
-- so the new counters can be UPDATE-d unconditionally (no row-missing
-- branches in the heartbeat hot path).
INSERT INTO tg_session_health (session_id, updated_at)
SELECT id, NOW() FROM sessions WHERE platform = 'telegram'
ON CONFLICT (session_id) DO NOTHING;

-- 4. Drop any legacy session_backups foreign-key on session_id — the
-- whole point of backups is that they outlive the row, so the FK must
-- NOT cascade. Older Phase-4 dev branches may have created one; this
-- migration ensures we end up without it. Use a guarded DO block since
-- "ALTER TABLE … DROP CONSTRAINT IF EXISTS …" only became standard in
-- recent Postgres versions and we want to support the older deploy
-- environments listed in OPS.md.
DO $$
DECLARE
  con_name TEXT;
BEGIN
  SELECT conname INTO con_name
    FROM pg_constraint
   WHERE conrelid = 'session_backups'::regclass
     AND contype  = 'f'
     AND conkey   = ARRAY[(
       SELECT attnum FROM pg_attribute
        WHERE attrelid = 'session_backups'::regclass
          AND attname = 'session_id'
     )]::int2[];
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE session_backups DROP CONSTRAINT %I', con_name);
  END IF;
END $$;
