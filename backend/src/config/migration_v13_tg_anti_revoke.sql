-- =============================================================================
-- migration_v13_tg_anti_revoke.sql
--
-- Telegram anti-revocation hardening. Adds:
--   1. DC pinning columns on sessions(dc_id, dc_ip, dc_port).
--   2. tg_session_health: per-session institutional state — auth_key age,
--      consecutive flood waits, last login attempt, bootstrap status,
--      last GetAuthorizations probe, persisted active_authorizations JSON.
--   3. tg_detection_events: append-only audit trail of every revocation,
--      flood wait, AUTH_KEY error, geo jump, DC migrate event. Mirrors
--      ig_detection_events from migration_v12.
--   4. sessions.last_online_status_at and sessions.last_ping_at columns to
--      separate "we sent UpdateStatus(offline=false)" from the heartbeat
--      tick (so we don't fire UpdateStatus on every heartbeat).
--
-- Idempotent: every CREATE / ALTER uses IF NOT EXISTS / IF EXISTS.
-- =============================================================================

-- 1. DC pinning -----------------------------------------------------------
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS dc_id   SMALLINT,
  ADD COLUMN IF NOT EXISTS dc_ip   VARCHAR(64),
  ADD COLUMN IF NOT EXISTS dc_port INTEGER;

-- 1b. presence + ping bookkeeping ----------------------------------------
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS last_online_status_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS last_ping_at          TIMESTAMP,
  ADD COLUMN IF NOT EXISTS last_authorizations_check_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS auth_key_first_seen_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_sessions_dc_id ON sessions(dc_id) WHERE dc_id IS NOT NULL;

-- 2. tg_session_health -----------------------------------------------------
CREATE TABLE IF NOT EXISTS tg_session_health (
  session_id              INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  auth_key_age_s          BIGINT      DEFAULT 0,
  consecutive_flood_waits INTEGER     DEFAULT 0,
  last_flood_seconds      INTEGER     DEFAULT 0,
  last_flood_at           TIMESTAMP,
  last_login_attempt_at   TIMESTAMP,
  last_reauth_required_at TIMESTAMP,
  bootstrapped_at         TIMESTAMP,
  bootstrap_attempts      INTEGER     DEFAULT 0,
  active_authorizations   JSONB,
  last_ip_country         VARCHAR(8),
  ip_country_jumps_24h    INTEGER     DEFAULT 0,
  dc_migrate_count_24h    INTEGER     DEFAULT 0,
  consecutive_failed_pings INTEGER    DEFAULT 0,
  last_authorizations_check_at TIMESTAMP,
  risk_score              NUMERIC(5,3) DEFAULT 0.0,
  risk_score_updated_at   TIMESTAMP,
  notes                   TEXT,
  updated_at              TIMESTAMP   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tg_session_health_risk
  ON tg_session_health(risk_score)
  WHERE risk_score > 0.0;

CREATE INDEX IF NOT EXISTS idx_tg_session_health_authcheck
  ON tg_session_health(last_authorizations_check_at);

-- 3. tg_detection_events ---------------------------------------------------
-- Append-only forensic trail mirroring ig_detection_events (migration v12).
CREATE TABLE IF NOT EXISTS tg_detection_events (
  id                 BIGSERIAL PRIMARY KEY,
  session_id         INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  user_id            INTEGER REFERENCES users(id)    ON DELETE SET NULL,
  event_type         VARCHAR(64) NOT NULL,
  severity           VARCHAR(16) NOT NULL DEFAULT 'info',
  http_status        INTEGER,
  api_method         VARCHAR(128),
  raw_excerpt        TEXT,
  fingerprint        JSONB,
  occurred_at        TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tg_detection_session_time
  ON tg_detection_events(session_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_tg_detection_type_time
  ON tg_detection_events(event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_tg_detection_user_time
  ON tg_detection_events(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_tg_detection_severity_time
  ON tg_detection_events(severity, occurred_at DESC)
  WHERE severity IN ('warning','critical');

-- 4. Backfill: bootstrap a tg_session_health row for every existing
-- telegram session so the heartbeat / risk score logic doesn't have to
-- handle missing rows.
INSERT INTO tg_session_health (session_id, updated_at)
SELECT id, NOW() FROM sessions WHERE platform = 'telegram'
ON CONFLICT (session_id) DO NOTHING;

-- 5. Default auth_key_first_seen_at to created_at where unknown so the
-- "auth key age" risk factor can be computed for legacy rows.
UPDATE sessions
   SET auth_key_first_seen_at = COALESCE(auth_key_first_seen_at, created_at)
 WHERE platform = 'telegram'
   AND auth_key_first_seen_at IS NULL;
