-- =====================================================================
-- Migration v2: Persistent Sessions, Change-2FA Jobs, OTP Jobs, Proxies
-- =====================================================================
-- Adds tables and columns required by:
--   * Upgrade 1: Persistent session keep-alive / restore (last_heartbeat)
--   * Upgrade 2: Change 2FA jobs (bulk + individual)
--   * Upgrade 3: Get OTP scan jobs (5-minute scans)
--   * Upgrade 4: Dynamic proxy system (free scraper + manual proxies)
-- =====================================================================

-- ----------------------------------------------------------------------
-- Sessions: keep-alive metadata + proxy binding
-- ----------------------------------------------------------------------
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS last_heartbeat TIMESTAMP;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS proxy_id INTEGER;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS keep_alive BOOLEAN DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_sessions_logged_in ON sessions(is_logged_in)
  WHERE is_logged_in = TRUE;

-- ----------------------------------------------------------------------
-- Change-2FA jobs (Upgrade 2)
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS change_2fa_jobs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  mode VARCHAR(20) NOT NULL CHECK (mode IN ('bulk', 'individual')),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  total_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  options JSONB,
  error_message TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  started_at TIMESTAMP,
  completed_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS change_2fa_job_items (
  id SERIAL PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES change_2fa_jobs(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  -- old/new password are encrypted at-rest using utils/crypto
  old_password_enc TEXT NOT NULL,
  new_password_enc TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  error_code VARCHAR(64),
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_change_2fa_jobs_user ON change_2fa_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_change_2fa_items_job ON change_2fa_job_items(job_id);
CREATE INDEX IF NOT EXISTS idx_change_2fa_items_session ON change_2fa_job_items(session_id);

-- ----------------------------------------------------------------------
-- OTP scan jobs (Upgrade 3)
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS otp_jobs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  total_count INTEGER NOT NULL DEFAULT 0,
  detected_count INTEGER NOT NULL DEFAULT 0,
  duration_seconds INTEGER NOT NULL DEFAULT 300,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  started_at TIMESTAMP,
  expires_at TIMESTAMP,
  completed_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS otp_job_items (
  id SERIAL PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES otp_jobs(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'scanning',
  otp_code VARCHAR(32),
  raw_message TEXT,
  detected_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_otp_jobs_user ON otp_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_otp_items_job ON otp_job_items(job_id);
CREATE INDEX IF NOT EXISTS idx_otp_items_session ON otp_job_items(session_id);

-- ----------------------------------------------------------------------
-- Proxy pool (Upgrade 4)
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS proxies (
  id SERIAL PRIMARY KEY,
  host VARCHAR(255) NOT NULL,
  port INTEGER NOT NULL,
  protocol VARCHAR(20) NOT NULL DEFAULT 'socks5'
    CHECK (protocol IN ('socks5', 'socks4', 'http', 'https', 'mtproto')),
  username VARCHAR(255),
  password_enc TEXT,
  -- mtproto secret (hex), only relevant when protocol = 'mtproto'
  secret VARCHAR(255),
  source VARCHAR(20) NOT NULL DEFAULT 'free'
    CHECK (source IN ('free', 'manual')),
  is_working BOOLEAN NOT NULL DEFAULT FALSE,
  priority INTEGER NOT NULL DEFAULT 0,
  -- per-IP rolling assignment counters (max 4 sessions / IP)
  active_assignments INTEGER NOT NULL DEFAULT 0,
  total_assignments INTEGER NOT NULL DEFAULT 0,
  last_checked_at TIMESTAMP,
  last_failed_at TIMESTAMP,
  last_latency_ms INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  metadata JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (host, port, protocol)
);

CREATE INDEX IF NOT EXISTS idx_proxies_working ON proxies(is_working, priority DESC);
CREATE INDEX IF NOT EXISTS idx_proxies_source ON proxies(source);

-- A row representing the local VPS / direct egress, kept once and reused.
INSERT INTO proxies (host, port, protocol, source, is_working, priority, metadata)
VALUES ('__direct__', 0, 'http', 'manual', TRUE, 1000,
        '{"label":"VPS direct connection","direct":true}'::jsonb)
ON CONFLICT (host, port, protocol) DO NOTHING;

-- Track which proxy each session is currently bound to (for 4-per-IP limits).
CREATE TABLE IF NOT EXISTS session_proxy_assignments (
  session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  proxy_id INTEGER NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
  assigned_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_proxy_proxy ON session_proxy_assignments(proxy_id);
