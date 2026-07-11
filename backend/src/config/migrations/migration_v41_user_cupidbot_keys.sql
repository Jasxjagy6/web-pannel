-- Migration: per-user CupidBot API keys
CREATE TABLE IF NOT EXISTS user_cupidbot_keys (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  api_key VARCHAR(255) NOT NULL,
  is_valid BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_cupidbot_keys_user_id ON user_cupidbot_keys(user_id);
