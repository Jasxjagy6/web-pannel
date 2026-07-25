-- Model @SpamBot's two non-clean states exactly:
--   limited: cold-DM/add-member restrictions, optionally until a UTC deadline
--   frozen:  the exact permanent "account was blocked" response
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS spam_limit_until TIMESTAMPTZ;

ALTER TABLE sessions
  DROP CONSTRAINT IF EXISTS sessions_spam_status_check;

UPDATE sessions
   SET spam_status = 'frozen',
       spam_limit_until = NULL
 WHERE platform = 'telegram'
   AND spam_status_message ~* '^\s*Your account was blocked for violations of the Telegram Terms of Service based on user reports confirmed by our moderators\.\s*$';

UPDATE sessions
   SET spam_status = 'limited'
 WHERE platform = 'telegram'
   AND spam_status <> 'frozen'
   AND spam_status_message IS NOT NULL
   AND (
     spam_status_message ILIKE '%account is now limited until%'
     OR spam_status_message ILIKE '%while the account is limited%'
     OR spam_status_message ILIKE '%anti-spam systems%'
     OR spam_status_message ILIKE '%not be able to send messages to people%'
   );

-- Any remaining value came from the previous broad "restricted" classifier.
-- It was non-clean but not the exact permanent-block response, so Limited is
-- the conservative state and does not activate the global frozen gate.
UPDATE sessions
   SET spam_status = 'limited'
 WHERE platform = 'telegram' AND spam_status = 'restricted';

-- Backfill deadlines captured in the canonical English reply. Invalid or
-- absent dates remain NULL and require a later @SpamBot recheck.
UPDATE sessions
   SET spam_limit_until = (
     (REGEXP_MATCH(
       spam_status_message,
       'limited until ([0-9]{1,2} [A-Za-z]{3} [0-9]{4}, [0-9]{1,2}:[0-9]{2}) UTC',
       'i'
     ))[1] || ' UTC'
   )::timestamptz
 WHERE platform = 'telegram'
   AND spam_status = 'limited'
   AND spam_status_message ~* 'limited until [0-9]{1,2} [A-Za-z]{3} [0-9]{4}, [0-9]{1,2}:[0-9]{2} UTC';

ALTER TABLE sessions
  ADD CONSTRAINT sessions_spam_status_check
  CHECK (spam_status IN ('unknown', 'clean', 'limited', 'frozen'));

CREATE INDEX IF NOT EXISTS idx_sessions_user_spam_limit_until
  ON sessions(user_id, spam_limit_until)
  WHERE platform = 'telegram' AND spam_status = 'limited';
