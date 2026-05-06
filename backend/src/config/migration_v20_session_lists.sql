-- ============================================================================
-- v20: Session-lists feature ("Organise" sessions into named groups).
--
-- Why: operators that manage 30-100+ sessions (across Telegram and
-- Instagram) want to pre-group sessions and then use those groups
-- everywhere a flow accepts a session_ids array (messaging, scrape,
-- privacy, groups, change-2FA, get-OTP, OTP relay, anti-detect,
-- account-settings).
--
-- Two tables: a header (`session_lists`) and a join table
-- (`session_list_members`). Per-user, per-platform. Empty platform =
-- 'any' (operator chose not to lock the list to one panel).
--
-- Additive-only; uses CREATE TABLE IF NOT EXISTS so re-runs are safe.
-- ============================================================================

CREATE TABLE IF NOT EXISTS session_lists (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform    VARCHAR(20) NOT NULL DEFAULT 'telegram',
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_lists_user_id
  ON session_lists(user_id);
CREATE INDEX IF NOT EXISTS idx_session_lists_user_platform
  ON session_lists(user_id, platform);
CREATE UNIQUE INDEX IF NOT EXISTS uq_session_lists_user_platform_name
  ON session_lists(user_id, platform, lower(name));

CREATE TABLE IF NOT EXISTS session_list_members (
  list_id    INTEGER NOT NULL REFERENCES session_lists(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  added_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (list_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_session_list_members_list_id
  ON session_list_members(list_id);
CREATE INDEX IF NOT EXISTS idx_session_list_members_session_id
  ON session_list_members(session_id);

COMMENT ON TABLE session_lists IS
  'Operator-managed named groups of sessions, used to pre-select sessions for bulk actions (messaging, scrape, privacy, etc.).';
COMMENT ON TABLE session_list_members IS
  'Membership join table: one row per (list, session). Cascades on either parent deletion.';
