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
  session_id INTEGER REFERENCES sessions(id),
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
  session_id INTEGER REFERENCES sessions(id),
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
CREATE TABLE IF NOT EXISTS message_logs (
  id SERIAL PRIMARY KEY,
  job_id INTEGER REFERENCES messaging_jobs(id),
  session_id INTEGER REFERENCES sessions(id),
  target_id BIGINT,
  status VARCHAR(20),
  error_message TEXT,
  sent_at TIMESTAMP DEFAULT NOW()
);

-- Group operations table
CREATE TABLE IF NOT EXISTS group_operations (
  id SERIAL PRIMARY KEY,
  session_id INTEGER REFERENCES sessions(id),
  target_group_id VARCHAR(50),
  operation VARCHAR(20),
  user_list JSONB,
  status VARCHAR(20) DEFAULT 'pending',
  total_count INTEGER,
  success_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
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
CREATE INDEX IF NOT EXISTS idx_group_operations_session_id ON group_operations(session_id);
CREATE INDEX IF NOT EXISTS idx_lists_user_id ON lists(user_id);
CREATE INDEX IF NOT EXISTS idx_list_items_list_id ON list_items(list_id);
CREATE INDEX IF NOT EXISTS idx_reports_user_id ON reports(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id ON activity_logs(user_id);
