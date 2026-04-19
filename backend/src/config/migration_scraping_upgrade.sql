-- Institutional-grade schema migration for scraping system
-- Run this to upgrade from the basic schema to full-featured scraping support

-- ============================================================================
-- SCRAPED USERS: Add comprehensive columns for advanced filtering
-- ============================================================================

ALTER TABLE scraped_users ADD COLUMN IF NOT EXISTS access_hash BIGINT;
ALTER TABLE scraped_users ADD COLUMN IF NOT EXISTS account_created_at TIMESTAMP;
ALTER TABLE scraped_users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMP;
ALTER TABLE scraped_users ADD COLUMN IF NOT EXISTS has_profile_photo BOOLEAN DEFAULT FALSE;
ALTER TABLE scraped_users ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE scraped_users ADD COLUMN IF NOT EXISTS common_chats_count INTEGER DEFAULT 0;
ALTER TABLE scraped_users ADD COLUMN IF NOT EXISTS restriction_reason TEXT;
ALTER TABLE scraped_users ADD COLUMN IF NOT EXISTS inviter_id BIGINT;
ALTER TABLE scraped_users ADD COLUMN IF NOT EXISTS join_date TIMESTAMP;
ALTER TABLE scraped_users ADD COLUMN IF NOT EXISTS bot_score FLOAT DEFAULT 0.0;
ALTER TABLE scraped_users ADD COLUMN IF NOT EXISTS bot_flags JSONB;

-- ============================================================================
-- SCRAPING JOBS: Add multi-session and advanced features
-- ============================================================================

ALTER TABLE scraping_jobs ADD COLUMN IF NOT EXISTS session_ids INTEGER[]; -- Array of session IDs for multi-session scraping
ALTER TABLE scraping_jobs ADD COLUMN IF NOT EXISTS target_ids TEXT[]; -- Array of targets for multi-target scraping
ALTER TABLE scraping_jobs ADD COLUMN IF NOT EXISTS job_mode VARCHAR(20) DEFAULT 'single'; -- single, multi-session, multi-target
ALTER TABLE scraping_jobs ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE scraping_jobs ADD COLUMN IF NOT EXISTS flood_wait_remaining INTEGER DEFAULT 0;
ALTER TABLE scraping_jobs ADD COLUMN IF NOT EXISTS stats JSONB DEFAULT '{"total_found": 0, "new_users": 0, "duplicates": 0, "bots_filtered": 0, "errors": 0}'::jsonb;

-- ============================================================================
-- INDEXES: Add performance indexes for filtering and querying
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_scraped_users_telegram_id ON scraped_users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_scraped_users_username ON scraped_users(username) WHERE username IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scraped_users_is_bot ON scraped_users(is_bot);
CREATE INDEX IF NOT EXISTS idx_scraped_users_is_premium ON scraped_users(is_premium);
CREATE INDEX IF NOT EXISTS idx_scraped_users_has_photo ON scraped_users(has_profile_photo);
CREATE INDEX IF NOT EXISTS idx_scraped_users_bot_score ON scraped_users(bot_score);
CREATE INDEX IF NOT EXISTS idx_scraped_users_scraped_at ON scraped_users(scraped_at);
CREATE INDEX IF NOT EXISTS idx_scraped_users_account_created ON scraped_users(account_created_at);

-- ============================================================================
-- LISTS: Add missing columns for list items
-- ============================================================================

ALTER TABLE list_items ADD COLUMN IF NOT EXISTS is_bot BOOLEAN DEFAULT FALSE;
ALTER TABLE list_items ADD COLUMN IF NOT EXISTS is_premium BOOLEAN DEFAULT FALSE;
ALTER TABLE list_items ADD COLUMN IF NOT EXISTS telegram_id_hash VARCHAR(64); -- For deduplication

CREATE INDEX IF NOT EXISTS idx_list_items_telegram_id ON list_items(telegram_id);
CREATE INDEX IF NOT EXISTS idx_list_items_is_bot ON list_items(is_bot);

-- ============================================================================
-- SESSIONS: Add health tracking columns
-- ============================================================================

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS rate_limit_until TIMESTAMP;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS flood_wait_seconds INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS total_scraped_users INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_scrape_at TIMESTAMP;

-- ============================================================================
-- CREATE: Global deduplication table
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_dedup_cache (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  telegram_id BIGINT NOT NULL,
  first_seen TIMESTAMP DEFAULT NOW(),
  last_seen TIMESTAMP DEFAULT NOW(),
  source_job_id INTEGER,
  UNIQUE(user_id, telegram_id)
);

CREATE INDEX IF NOT EXISTS idx_dedup_cache_user_telegram ON user_dedup_cache(user_id, telegram_id);

-- ============================================================================
-- CREATE: Scrape schedules table
-- ============================================================================

CREATE TABLE IF NOT EXISTS scrape_schedules (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  session_ids INTEGER[],
  target_ids TEXT[],
  limit_per_target INTEGER DEFAULT 1000,
  filter_bots BOOLEAN DEFAULT TRUE,
  bot_filter_options JSONB,
  save_to_list BOOLEAN DEFAULT FALSE,
  list_name VARCHAR(255),
  schedule_type VARCHAR(20) DEFAULT 'once', -- once, daily, weekly, custom
  cron_expression VARCHAR(100),
  next_run TIMESTAMP,
  last_run TIMESTAMP,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  options JSONB
);

CREATE INDEX IF NOT EXISTS idx_schedules_user_id ON scrape_schedules(user_id);
CREATE INDEX IF NOT EXISTS idx_schedules_next_run ON scrape_schedules(next_run) WHERE is_active = true;

-- ============================================================================
-- CREATE: Export history table
-- ============================================================================

CREATE TABLE IF NOT EXISTS export_history (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  job_id INTEGER REFERENCES scraping_jobs(id),
  format VARCHAR(10),
  filters_applied JSONB,
  total_records INTEGER,
  file_hash VARCHAR(64),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_export_history_user_id ON export_history(user_id);

COMMENT ON COLUMN scraped_users.bot_score IS 'Composite bot likelihood score (0-1)';
COMMENT ON COLUMN scraped_users.bot_flags IS 'JSON array of bot detection flags triggered';
COMMENT ON COLUMN scraping_jobs.session_ids IS 'Array of session IDs used for multi-session scraping';
COMMENT ON COLUMN scraping_jobs.target_ids IS 'Array of group/channel IDs for multi-target scraping';
