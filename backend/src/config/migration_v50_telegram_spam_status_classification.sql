-- Split ordinary @SpamBot restrictions from Telegram's explicit frozen state.
ALTER TABLE sessions
  DROP CONSTRAINT IF EXISTS sessions_spam_status_check;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_spam_status_check
  CHECK (spam_status IN ('unknown', 'clean', 'restricted', 'frozen'));

-- Reclassify replies captured by the first scanner version. These messages
-- describe spam limits/blocks, not Telegram's explicit "account is frozen"
-- state, so they must not exclude the session from panel work.
UPDATE sessions
   SET spam_status = 'restricted'
 WHERE platform = 'telegram'
   AND spam_status = 'unknown'
   AND spam_status_message IS NOT NULL
   AND (
     spam_status_message ILIKE '%account was blocked for violations%'
     OR spam_status_message ILIKE '%while the account is limited%'
     OR spam_status_message ILIKE '%anti-spam systems%'
     OR spam_status_message ILIKE '%not be able to send messages to people%'
     OR spam_status_message ILIKE '%less strict limits%'
   );
