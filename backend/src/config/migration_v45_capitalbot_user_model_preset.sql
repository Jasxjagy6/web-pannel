-- Migration: per-user CapitalBot model/preset selection
ALTER TABLE user_capitalbot_keys
  ADD COLUMN IF NOT EXISTS model_id INTEGER,
  ADD COLUMN IF NOT EXISTS preset_id INTEGER;
