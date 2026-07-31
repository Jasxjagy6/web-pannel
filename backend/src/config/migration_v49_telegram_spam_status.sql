-- Persist Telegram's authoritative @SpamBot restriction state.
-- Existing sessions remain usable until they are explicitly checked.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS spam_status VARCHAR(20) NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS spam_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS spam_status_message TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sessions_spam_status_check'
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_spam_status_check
      CHECK (spam_status IN ('unknown', 'clean', 'frozen'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sessions_user_spam_status
  ON sessions(user_id, spam_status)
  WHERE platform = 'telegram';
