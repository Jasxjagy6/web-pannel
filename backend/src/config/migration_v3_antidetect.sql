-- =====================================================================
-- Migration v3: Anti-Detect Layer
-- =====================================================================
-- Adds the per-session device identity, the bound proxy reference and
-- the behavior log used by the warm-up scheduler. All statements are
-- idempotent so the migration can be re-applied safely.
-- =====================================================================

-- ----------------------------------------------------------------------
-- Sessions: persisted device identity + 1:1 proxy binding + warm-up
-- ----------------------------------------------------------------------
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS device_identity JSONB;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS bound_proxy_id INTEGER;

-- Best-effort FK; ignore if already added.
DO $$ BEGIN
  ALTER TABLE sessions
    ADD CONSTRAINT sessions_bound_proxy_fk
    FOREIGN KEY (bound_proxy_id) REFERENCES proxies(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS warmup_state JSONB DEFAULT '{}'::jsonb;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS last_warmup_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_sessions_bound_proxy
  ON sessions(bound_proxy_id) WHERE bound_proxy_id IS NOT NULL;

-- ----------------------------------------------------------------------
-- Behavior log: a record of every warm-up action we performed against
-- a session. Kept lightweight so we can prune old rows easily.
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS behavior_log (
  id BIGSERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  action VARCHAR(64) NOT NULL,
  target VARCHAR(255),
  succeeded BOOLEAN NOT NULL DEFAULT TRUE,
  error_code VARCHAR(64),
  error_message TEXT,
  details JSONB,
  performed_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_behavior_log_session
  ON behavior_log(session_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_behavior_log_recent
  ON behavior_log(performed_at DESC);
