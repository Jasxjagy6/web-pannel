-- Users table
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT NOW(),
  last_login TIMESTAMP
);

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  phone VARCHAR(20),
  session_file_path VARCHAR(500),
  api_id INTEGER,
  api_hash VARCHAR(100),
  status VARCHAR(20) DEFAULT 'uploaded',
  is_2fa_enabled BOOLEAN DEFAULT FALSE,
  is_logged_in BOOLEAN DEFAULT FALSE,
  account_info JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  last_active TIMESTAMP
);

-- Scraping jobs table
CREATE TABLE IF NOT EXISTS scraping_jobs (
  id SERIAL PRIMARY KEY,
  session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  target_type VARCHAR(20),
  target_id VARCHAR(50),
  target_title VARCHAR(255),
  status VARCHAR(20) DEFAULT 'pending',
  progress INTEGER DEFAULT 0,
  total_found INTEGER DEFAULT 0,
  options JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

-- Scraped users table
CREATE TABLE IF NOT EXISTS scraped_users (
  id SERIAL PRIMARY KEY,
  job_id INTEGER REFERENCES scraping_jobs(id),
  telegram_id BIGINT,
  username VARCHAR(100),
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  phone VARCHAR(20),
  is_bot BOOLEAN DEFAULT FALSE,
  is_premium BOOLEAN DEFAULT FALSE,
  scraped_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(job_id, telegram_id)
);

-- Messaging jobs table
CREATE TABLE IF NOT EXISTS messaging_jobs (
  id SERIAL PRIMARY KEY,
  session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  job_type VARCHAR(20),
  target_list JSONB,
  message_content TEXT,
  message_type VARCHAR(20) DEFAULT 'text',
  media_path VARCHAR(500),
  status VARCHAR(20) DEFAULT 'pending',
  total_count INTEGER DEFAULT 0,
  sent_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  skipped_count INTEGER DEFAULT 0,
  options JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

-- Message logs
--
-- `target_id` is TEXT so it can hold any of the three forms our targets
-- come in: numeric Telegram ID (`12345`), `@username`, or `+phone`. We
-- used to use BIGINT here, but `normalizeTargetId` returns the shape the
-- caller passed and the @username path was crashing the bulk insert. See
-- migration_v21_message_logs_target_id_text.sql.
CREATE TABLE IF NOT EXISTS message_logs (
  id SERIAL PRIMARY KEY,
  job_id INTEGER REFERENCES messaging_jobs(id) ON DELETE SET NULL,
  session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  target_id TEXT,
  status VARCHAR(20),
  error_message TEXT,
  sent_at TIMESTAMP DEFAULT NOW()
);

-- Group operations table
CREATE TABLE IF NOT EXISTS group_operations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  target_group_id VARCHAR(50),
  operation VARCHAR(20),
  operation_type VARCHAR(50),
  user_list JSONB,
  status VARCHAR(20) DEFAULT 'pending',
  total_count INTEGER,
  total_users INTEGER,
  success_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  options JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  last_progress_at TIMESTAMP
);

-- Lists table
CREATE TABLE IF NOT EXISTS lists (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  name VARCHAR(255),
  type VARCHAR(20),
  items_count INTEGER DEFAULT 0,
  source VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
);

-- List items table
CREATE TABLE IF NOT EXISTS list_items (
  id SERIAL PRIMARY KEY,
  list_id INTEGER REFERENCES lists(id),
  telegram_id BIGINT,
  username VARCHAR(100),
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  phone VARCHAR(20),
  access_hash BIGINT,
  added_at TIMESTAMP DEFAULT NOW()
);

-- Reports table
CREATE TABLE IF NOT EXISTS reports (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  report_type VARCHAR(20),
  target_id VARCHAR(50),
  target_title VARCHAR(255),
  period_start TIMESTAMP,
  period_end TIMESTAMP,
  data JSONB,
  generated_at TIMESTAMP DEFAULT NOW()
);

-- Activity logs
CREATE TABLE IF NOT EXISTS activity_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action VARCHAR(50),
  entity_type VARCHAR(20),
  entity_id INTEGER,
  details JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Job queue table
CREATE TABLE IF NOT EXISTS job_queue (
  id SERIAL PRIMARY KEY,
  queue_name VARCHAR(50),
  job_data JSONB,
  status VARCHAR(20),
  result JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  processed_at TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_scraping_jobs_session_id ON scraping_jobs(session_id);
CREATE INDEX IF NOT EXISTS idx_scraping_jobs_status ON scraping_jobs(status);
CREATE INDEX IF NOT EXISTS idx_scraped_users_job_id ON scraped_users(job_id);
CREATE INDEX IF NOT EXISTS idx_messaging_jobs_session_id ON messaging_jobs(session_id);
CREATE INDEX IF NOT EXISTS idx_messaging_jobs_status ON messaging_jobs(status);
CREATE INDEX IF NOT EXISTS idx_message_logs_job_id ON message_logs(job_id);
CREATE INDEX IF NOT EXISTS idx_group_operations_user_id ON group_operations(user_id);
CREATE INDEX IF NOT EXISTS idx_group_operations_session_id ON group_operations(session_id);
CREATE INDEX IF NOT EXISTS idx_lists_user_id ON lists(user_id);
CREATE INDEX IF NOT EXISTS idx_list_items_list_id ON list_items(list_id);
CREATE INDEX IF NOT EXISTS idx_reports_user_id ON reports(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id ON activity_logs(user_id);

-- AI auto-responder tables (Telegram only)
CREATE TABLE IF NOT EXISTS ai_session_settings (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_session_settings_session_id ON ai_session_settings(session_id);
CREATE INDEX IF NOT EXISTS idx_ai_session_settings_enabled ON ai_session_settings(enabled);

CREATE TABLE IF NOT EXISTS ai_chat_settings (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  peer_type VARCHAR(20) NOT NULL CHECK (peer_type IN ('user','chat','channel')),
  peer_id BIGINT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, peer_type, peer_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_chat_settings_session_id ON ai_chat_settings(session_id);
CREATE INDEX IF NOT EXISTS idx_ai_chat_settings_peer ON ai_chat_settings(session_id, peer_type, peer_id);

CREATE TABLE IF NOT EXISTS ai_chat_memories (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  peer_type VARCHAR(20) NOT NULL CHECK (peer_type IN ('user','chat','channel')),
  peer_id BIGINT NOT NULL,
  messages JSONB NOT NULL DEFAULT '[]',
  message_count INTEGER NOT NULL DEFAULT 0,
  last_incoming_at TIMESTAMPTZ,
  last_outgoing_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, peer_type, peer_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_chat_memories_session_id ON ai_chat_memories(session_id);
CREATE INDEX IF NOT EXISTS idx_ai_chat_memories_peer ON ai_chat_memories(session_id, peer_type, peer_id);
CREATE INDEX IF NOT EXISTS idx_ai_chat_memories_last_incoming ON ai_chat_memories(last_incoming_at);

CREATE TABLE IF NOT EXISTS ai_response_logs (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  peer_type VARCHAR(20) NOT NULL,
  peer_id BIGINT NOT NULL,
  incoming_msg_id BIGINT,
  request_payload JSONB,
  response_payload JSONB,
  status VARCHAR(20) NOT NULL,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_response_logs_session_id ON ai_response_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_ai_response_logs_created_at ON ai_response_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_response_logs_status ON ai_response_logs(status);
