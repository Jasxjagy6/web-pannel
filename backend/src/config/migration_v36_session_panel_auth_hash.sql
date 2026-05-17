-- migration_v36_session_panel_auth_hash.sql
--
-- Persist each Telegram panel session's OWN account.Authorization hash
-- (the row that Telegram marks `current=true` when the panel connects
-- with that auth_key) so the bulk auth-purge runner has an independent,
-- DB-side identity check on top of the in-flight `current` flag.
--
-- Background: in v35 we shipped a "Terminate other sessions" runner
-- (PR #106) that relied solely on the `current` boolean from
-- `account.Authorization` to identify the panel's own row. That field
-- is declared `?boolean` in the MTProto schema — Telegram omits it
-- when the flag is unset, and an operator hit a state where NO row
-- had it set (DC migrate in progress / key freshly bound / transient
-- flap). The runner therefore treated EVERY row as "other" and
-- terminated the panel's own session.
--
-- This migration adds:
--   sessions.tg_panel_auth_hash
--     The decimal-string form of the `current=true` row's `hash` from
--     the last successful `account.GetAuthorizations` call against
--     this session. Stored as TEXT (not BIGINT) because Telegram's
--     `long` exceeds Number.MAX_SAFE_INTEGER and we want the exact
--     value for equality checks, not a rounded approximation.
--   sessions.tg_panel_auth_hash_observed_at
--     Wall-clock timestamp of the last observation.
--
-- The runner refuses to proceed with a purge unless:
--   (a) exactly one row in the live listAuthorizations response has
--       current=true, AND
--   (b) if tg_panel_auth_hash is non-NULL, the live current row's hash
--       matches the stored value (mismatch ⇒ abort, do NOT touch any
--       authorizations on that account).
--
-- Both columns are nullable + default NULL so existing rows are
-- unaffected; first successful preview/list populates them.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.

ALTER TABLE sessions
    ADD COLUMN IF NOT EXISTS tg_panel_auth_hash TEXT NULL;

ALTER TABLE sessions
    ADD COLUMN IF NOT EXISTS tg_panel_auth_hash_observed_at TIMESTAMPTZ NULL;

-- Cheap partial index so we can answer "do we have a persisted hash
-- for this session?" without scanning all rows. The hash itself is
-- not queried by value, only by presence + equality on a known id.
CREATE INDEX IF NOT EXISTS sessions_tg_panel_auth_hash_present_idx
    ON sessions ((tg_panel_auth_hash IS NOT NULL))
    WHERE platform = 'telegram';
