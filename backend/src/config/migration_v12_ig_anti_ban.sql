-- =============================================================================
-- Migration v12 — Instagram anti-ban Phase 3 (observability + safety net)
-- =============================================================================
-- Phase 3 of the IG_ANTI_BAN_PROPOSAL plan adds:
--   * ig_detection_events  — structured audit table the IG provider writes to
--                            every time IG returns a checkpoint / feedback /
--                            action_blocked / login_required / rate_limited
--                            response. Used to drive the risk score (B16) and
--                            the admin /api/admin/ig-detection-events
--                            dashboard.
--   * Indexes for the two query patterns the admin UI hits:
--       - "events for this session, newest first"
--       - "all events of a given kind in the last 24h"
--   * NO schema changes on the sessions table. The risk score (B16) is
--     stored in `sessions.platform_state.riskScore` JSONB and does not
--     need a column.
-- All statements are idempotent so re-running is safe.
-- =============================================================================

CREATE TABLE IF NOT EXISTS ig_detection_events (
  id                  BIGSERIAL PRIMARY KEY,
  session_id          INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  user_id             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- One of: checkpoint | feedback_required | action_blocked | login_required
  --        | rate_limited | cookie_missing | decrypt_failed | network
  event_kind          TEXT NOT NULL,
  -- The IG endpoint URL or "client.<verb>" identifier the call was on.
  api_path            TEXT,
  http_status         INTEGER,
  -- Truncated to 2 KB by the writer; we keep TEXT (no LENGTH() check) so
  -- existing rows aren't invalidated if the writer's truncation changes.
  response_body       TEXT,
  -- Allow-listed snapshot: { userAgent, secChUaPlatform, accept_language,
  -- proxy_country, action_class, hour_of_day_local, api_mode, app_version }.
  request_fingerprint JSONB,
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ig_detection_events_session_idx
  ON ig_detection_events (session_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS ig_detection_events_kind_time_idx
  ON ig_detection_events (event_kind, occurred_at DESC);

CREATE INDEX IF NOT EXISTS ig_detection_events_user_idx
  ON ig_detection_events (user_id, occurred_at DESC);
