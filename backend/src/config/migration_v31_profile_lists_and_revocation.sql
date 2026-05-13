-- Migration v31: profile lists (account-settings randomize source) + extra
-- columns for tracking the latest revocation event.
--
-- 1) `list_items` already has first_name / last_name / username. Add a `bio`
--    column so a "profile list" upload can carry the Telegram About blurb.
--    Existing list types are unaffected.
-- 2) `sessions.account_info` already stores revocation context in JSONB. No
--    schema change required there, but we add an index on `status` for the
--    cohort queries the Sessions UI runs while filtering revoked rows.
-- 3) Validation: list_items.bio is optional and ignored by every existing
--    list flow (messaging, group-add, scraping). Only the new profile-list
--    apply path reads it.

ALTER TABLE list_items
  ADD COLUMN IF NOT EXISTS bio TEXT;

-- Index helps the Sessions page filter Active / Revoked quickly when the
-- panel has thousands of rows.
CREATE INDEX IF NOT EXISTS idx_sessions_user_status
  ON sessions(user_id, status);

-- list_items.bio is short prose; no statistics needed.
COMMENT ON COLUMN list_items.bio
  IS 'Optional Telegram About text for profile-list entries. Ignored by non-profile list flows.';
