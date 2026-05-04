-- migration_v15_deployments.sql
--
-- Persistent audit trail for every deploy attempt. Every row written by the
-- `bin/upgrade` orchestrator (CLI runs, Telegram bot runs, automated CI runs)
-- and used by:
--   - `upgrade rollback` to find the previously-active SHA
--   - `upgrade status` to render recent history
--   - the Telegram /status command
--
-- Forward-compatible: pure additive — new table + new index, no touches to
-- existing schema.

CREATE TABLE IF NOT EXISTS deployments (
  id              SERIAL PRIMARY KEY,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  initiated_by    TEXT NOT NULL,
  -- 'cli:<linux-user>' or 'telegram:<userId>' or 'ci:<runner>'
  target_ref      TEXT,
  -- branch / tag the operator asked for (e.g. 'main', 'v2.3.1', 'abc1234')
  target_sha      TEXT,
  -- resolved 40-char git SHA actually deployed
  prev_sha        TEXT,
  -- SHA that was active before this deploy
  color_promoted  TEXT,
  -- 'blue' or 'green' (the color the new image was launched into)
  status          TEXT NOT NULL DEFAULT 'pending',
  -- pending | healthy | failed | rolled_back | aborted
  health_ms       INTEGER,
  -- how long /health/ready took to go green on the new color
  total_ms        INTEGER,
  -- end-to-end deploy duration
  error_message   TEXT,
  -- populated when status in ('failed','rolled_back','aborted')
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
  -- free-form: image tag, build mode, backup id, etc.
);

CREATE INDEX IF NOT EXISTS idx_deployments_started_at ON deployments(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);
