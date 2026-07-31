ALTER TABLE user_capitalbot_keys
  ADD COLUMN IF NOT EXISTS response_language VARCHAR(50) DEFAULT 'English';
