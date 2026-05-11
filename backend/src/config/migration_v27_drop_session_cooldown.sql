-- v27 — drop the per-session cooldown columns that were added in v24.
--
-- Why this migration exists:
--
--   The panel previously persisted a per-session "this session is on
--   cooldown" marker (cooldown_until / cooldown_reason / cooldown_set_at /
--   cooldown_seconds), set when GramJS surfaced FLOOD_WAIT_n or
--   PEER_FLOOD inside addMembers / sendBulk / etc. The session worker
--   pool and the routes/services that pick sessions for jobs then
--   refused to use any session whose cooldown_until was in the future.
--
--   In practice this caused two problems:
--
--     1. PEER_FLOOD does NOT carry a duration from Telegram. The panel
--        was applying a hardcoded 6h lockout (sessionCooldown.markPeerFlood)
--        to sessions Telegram had only flagged once, leaving the whole
--        account pool unusable for 6h after a single transient hit.
--
--     2. Even FLOOD_WAIT_n cooldowns surfaced after a single bulk run
--        and stayed there until the timestamp expired, blocking the
--        operator from running any further jobs with the affected
--        sessions even when they wanted to try anyway.
--
--   The operator explicitly asked us to remove the feature entirely:
--   the panel should attempt every session for every job, and the
--   in-run worker (sessionWorkerPool) is already responsible for
--   sleeping on FLOOD_WAIT_n and rotating off PEER_FLOODed sessions
--   for the remainder of THAT run. There is no value in persisting
--   the state across job invocations.
--
--   This drops the four cooldown columns and the supporting partial
--   index from the sessions table. The rest of the schema is unaffected.
--
-- Safety:
--
--   * Auth columns (session_file_path / session_string / session_data /
--     api_id / api_hash / phone / account_info) are NOT touched — every
--     session loads exactly as before this migration runs.
--   * `check-migration-safety.js` only blocks DROP COLUMN of columns
--     listed in its PROTECTED_COLUMNS list (the seven auth-key
--     columns above); the cooldown_* columns are not in that list.

DROP INDEX IF EXISTS idx_sessions_cooldown_until;

ALTER TABLE sessions
  DROP COLUMN IF EXISTS cooldown_until,
  DROP COLUMN IF EXISTS cooldown_reason,
  DROP COLUMN IF EXISTS cooldown_set_at,
  DROP COLUMN IF EXISTS cooldown_seconds;
