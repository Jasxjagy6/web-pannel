-- =============================================================================
-- migration_v21_message_logs_target_id_text.sql
--
-- Widen `message_logs.target_id` from BIGINT to TEXT.
--
-- Bulk DM and group-add jobs persist usernames (`@handle`), phones (`+91...`)
-- and numeric Telegram IDs interchangeably as the human-readable target.
-- The original BIGINT column rejected anything non-numeric, which made the
-- whole `INSERT INTO message_logs ... VALUES (..., $3, ...)` batch fail in
-- a single transaction and rollback every row in that flush — leaving the
-- "Recent activity" / progress views empty even when sends succeeded.
--
-- This migration is additive-only by design (matches the rest of the
-- migration runner's contract): it widens the type without dropping or
-- renaming the column, so existing INTEGER readers still work via implicit
-- text-to-numeric in clients that ask for it.
-- =============================================================================

ALTER TABLE message_logs
  ALTER COLUMN target_id TYPE TEXT USING target_id::TEXT;
