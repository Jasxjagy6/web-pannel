-- v25 — list_items.access_hash + group_operations live progress columns.
--
-- Why this migration exists:
--
--   1. Adding members by Telegram user_id requires the matching access_hash
--      to construct a valid InputUser. The scrape pipeline already captures
--      it on `scraped_users.access_hash`, but the `list_items` row that the
--      add-members worker actually feeds to GramJS dropped the column —
--      every user-id-only invite then failed with "Could not find the input
--      entity" and fell through to a stale @username, which Telegram
--      promptly rejected with "No user has X as username".
--
--      Adding `access_hash BIGINT NULL` lets the scrape→list copy preserve
--      it and lets CSV/JSON imports carry it as well. Existing rows stay
--      valid (the column is nullable), and the runtime path tolerates a
--      NULL just like before — it just can't bypass entity resolution
--      when there's no hash to bypass with.
--
--   2. The Operation History panel renders `success_count`/`failed_count`
--      from `group_operations`, but those columns were only updated at
--      finalisation. To support real-time status the worker now writes
--      progress on every per-user attempt; the new `last_progress_at`
--      column gives the UI a "last heartbeat" so it can surface a stalled
--      run without ambiguity.
--
-- All changes are additive / nullable / default-valued so existing rows stay
-- valid and rolling restarts during the deploy can mix v24 and v25 code.

-- 1. list_items: per-user access_hash (paired with telegram_id) -------------

ALTER TABLE list_items
  ADD COLUMN IF NOT EXISTS access_hash BIGINT NULL;

-- 2. group_operations: real-time progress heartbeat -------------------------

ALTER TABLE group_operations
  ADD COLUMN IF NOT EXISTS last_progress_at TIMESTAMP NULL;
