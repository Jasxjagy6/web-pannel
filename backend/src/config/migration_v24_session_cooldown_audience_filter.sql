-- v24 — session cooldown + audience resolution cache + list_items privacy fields.
--
-- Why this migration exists:
--
--   1. Sessions hit Telegram PEER_FLOOD / FloodWait while running add-members /
--      send-bulk jobs. We want to record an explicit "this session is on cooldown
--      until <timestamp>" so the worker session-pickers can skip it for jobs,
--      while privacy / 2fa / login pages still see and use the session normally.
--
--   2. Job runs waste sessions' RPC quota by asking Telegram about every list
--      entry, even ones that are obviously dead (deleted accounts, made-up
--      handles, banned accounts). We add a forever-cached audience resolution
--      cache keyed by (kind, normalized identifier) so each unique entry costs
--      at most one probe across all of history.
--
--   3. After a job runs the filter pipeline, the per-list_items rows learn
--      whether the user is `live`, `privacy_restricted`, or `not_found`. We
--      record that on the row so the next job for the same list can skip even
--      the cache lookup, and so the UI can mark "DM-only" users distinctly.
--
-- All changes are additive / nullable / default-valued so existing rows stay
-- valid.

-- 1. Sessions cooldown columns -------------------------------------------------

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS cooldown_until      TIMESTAMP   NULL,
  ADD COLUMN IF NOT EXISTS cooldown_reason     TEXT        NULL,
  ADD COLUMN IF NOT EXISTS cooldown_set_at     TIMESTAMP   NULL,
  ADD COLUMN IF NOT EXISTS cooldown_seconds    INTEGER     NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_cooldown_until
  ON sessions (cooldown_until)
  WHERE cooldown_until IS NOT NULL;

-- 2. Audience resolution cache (forever; keyed by normalized identifier) -------

-- identifier_kind values:
--   'username'   — bare lowercased @handle (no leading @)
--   'telegram_id' — numeric stringified id
--   'phone'       — E.164-normalized phone (no '+')
--
-- status values:
--   'live'                — confirmed reachable
--   'privacy_restricted'  — exists but cannot be added to groups (DM-only)
--   'not_found'           — deleted / never existed / banned (drop)
--   'unknown'             — probe failed transiently (retry next job)
CREATE TABLE IF NOT EXISTS audience_resolution_cache (
  identifier_kind   VARCHAR(32) NOT NULL,
  identifier_norm   TEXT        NOT NULL,
  status            VARCHAR(32) NOT NULL,
  resolved_username TEXT        NULL,
  resolved_id       TEXT        NULL,
  reason            TEXT        NULL,
  source            VARCHAR(32) NOT NULL DEFAULT 'unknown',
  probed_at         TIMESTAMP   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (identifier_kind, identifier_norm)
);

CREATE INDEX IF NOT EXISTS idx_audience_resolution_cache_status
  ON audience_resolution_cache (status);

-- 3. list_items: per-row privacy/state fields populated by the filter ----------
--    `privacy_status` mirrors the cache `status` enum but lives on the list_item
--    row so the next job can skip even the cache lookup.

ALTER TABLE list_items
  ADD COLUMN IF NOT EXISTS privacy_status      VARCHAR(32) NULL,
  ADD COLUMN IF NOT EXISTS privacy_reason      TEXT        NULL,
  ADD COLUMN IF NOT EXISTS last_filter_at      TIMESTAMP   NULL,
  ADD COLUMN IF NOT EXISTS dm_only             BOOLEAN     NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_list_items_privacy_status
  ON list_items (list_id, privacy_status)
  WHERE privacy_status IS NOT NULL;
