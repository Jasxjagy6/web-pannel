-- migration_v43_tracking.sql
--
-- "Tracking" module: a private inventory/CRM system for managing Telegram
-- accounts that are owned, uploaded, assigned, and sold. This module never
-- connects to Telegram or logs into any account — it is a pure manual
-- database + uploaded-session-file-metadata store.
--
-- Normalization: frequently-filtered/sorted columns live denormalized on
-- tracking_accounts (status, phone, username, telegram id, country, premium,
-- assigned_to, sale/purchase price, sold_at) so the list page is a single
-- indexed query with no joins. Everything else (session/SIM/security/
-- purchase detail, sales history, assignment history, notes, attachments,
-- tags) lives in side tables, joined only on the detail view.

-- 1. RBAC ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tracking_team_members (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'viewer'
    CHECK (role IN ('owner', 'admin', 'staff', 'viewer')),
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tracking_team_members_role ON tracking_team_members(role);

-- Bootstrap: every existing panel admin becomes a tracking owner immediately.
-- Admins promoted after this migration runs are picked up dynamically by
-- trackingTeamService.resolveMember()'s admin-fallback rule.
INSERT INTO tracking_team_members (user_id, role, permissions)
SELECT id, 'owner', '{}'::jsonb FROM users WHERE role = 'admin'
ON CONFLICT (user_id) DO NOTHING;

-- 2. Core account table ---------------------------------------------------
CREATE TABLE IF NOT EXISTS tracking_accounts (
  id SERIAL PRIMARY KEY,
  internal_code VARCHAR(50) UNIQUE,
  platform VARCHAR(20) NOT NULL DEFAULT 'telegram' CHECK (platform IN ('telegram')),

  -- Basic Information
  phone_number VARCHAR(30),
  country VARCHAR(100),
  country_code VARCHAR(8),
  telegram_user_id BIGINT,
  username VARCHAR(100),
  display_name VARCHAR(200),
  bio TEXT,
  is_premium BOOLEAN NOT NULL DEFAULT FALSE,
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  is_scam BOOLEAN NOT NULL DEFAULT FALSE,
  is_fake BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_at TIMESTAMPTZ,

  status VARCHAR(20) NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'reserved', 'sold', 'dead', 'banned', 'deleted', 'lost_access')),
  reserved_until TIMESTAMPTZ,

  -- Denormalized fields for cheap list/dashboard queries (source of truth
  -- lives in the side tables below; kept in sync by the service layer)
  assigned_to_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  purchase_price NUMERIC(12, 2),
  sale_price NUMERIC(12, 2),
  sold_at TIMESTAMPTZ,
  estimated_value NUMERIC(12, 2),
  backup_available BOOLEAN NOT NULL DEFAULT FALSE,

  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at TIMESTAMPTZ,

  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tracking_accounts_status ON tracking_accounts(status);
CREATE INDEX IF NOT EXISTS idx_tracking_accounts_phone ON tracking_accounts(phone_number);
CREATE INDEX IF NOT EXISTS idx_tracking_accounts_username ON tracking_accounts(username);
CREATE INDEX IF NOT EXISTS idx_tracking_accounts_telegram_user_id ON tracking_accounts(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_tracking_accounts_country ON tracking_accounts(country);
CREATE INDEX IF NOT EXISTS idx_tracking_accounts_assigned_to ON tracking_accounts(assigned_to_user_id);
CREATE INDEX IF NOT EXISTS idx_tracking_accounts_created_at ON tracking_accounts(created_at);
CREATE INDEX IF NOT EXISTS idx_tracking_accounts_sold_at ON tracking_accounts(sold_at);
CREATE INDEX IF NOT EXISTS idx_tracking_accounts_is_premium ON tracking_accounts(is_premium);
CREATE INDEX IF NOT EXISTS idx_tracking_accounts_not_deleted ON tracking_accounts(id) WHERE is_deleted = FALSE;

-- 3. Attachments (session file / backup / screenshots / documents) --------
CREATE TABLE IF NOT EXISTS tracking_attachments (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES tracking_accounts(id) ON DELETE CASCADE,
  category VARCHAR(20) NOT NULL
    CHECK (category IN ('session_file', 'screenshot', 'document', 'backup_file', 'other')),
  file_name VARCHAR(255) NOT NULL,
  file_path VARCHAR(500) NOT NULL,
  file_size_bytes BIGINT,
  mime_type VARCHAR(100),
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tracking_attachments_account_id ON tracking_attachments(account_id);
CREATE INDEX IF NOT EXISTS idx_tracking_attachments_category ON tracking_attachments(category);

-- 4. Session Information (1:1) --------------------------------------------
CREATE TABLE IF NOT EXISTS tracking_account_session_info (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL UNIQUE REFERENCES tracking_accounts(id) ON DELETE CASCADE,
  session_name VARCHAR(255),
  session_file_attachment_id INTEGER REFERENCES tracking_attachments(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ,
  session_size_bytes BIGINT,
  session_version VARCHAR(50),
  encryption_status VARCHAR(20) NOT NULL DEFAULT 'none'
    CHECK (encryption_status IN ('none', 'encrypted', 'unknown')),
  last_updated_at TIMESTAMPTZ,
  backup_available BOOLEAN NOT NULL DEFAULT FALSE,
  backup_attachment_id INTEGER REFERENCES tracking_attachments(id) ON DELETE SET NULL,
  backup_date TIMESTAMPTZ,
  -- Client/device fingerprint captured from a paired metadata JSON file at
  -- upload time (e.g. a session+info ZIP export from a session-selling
  -- tool). Stored for record-keeping only — never used to connect.
  app_id INTEGER,
  app_hash VARCHAR(64),
  device_model VARCHAR(100),
  system_version VARCHAR(100),
  client_app_version VARCHAR(50),
  lang_pack VARCHAR(30),
  system_lang_pack VARCHAR(30),
  app_config_hash VARCHAR(100),
  session_created_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. SIM Information (1:1) -------------------------------------------------
-- Note: recovery email is intentionally NOT stored here in plaintext, even
-- though the spec lists it under both SIM Info and Security. The single
-- source of truth is tracking_account_security.recovery_email_encrypted;
-- the API surfaces a computed recoveryEmailConfigured boolean instead, so
-- the same sensitive PII isn't duplicated at two different protection levels.
CREATE TABLE IF NOT EXISTS tracking_account_sim_info (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL UNIQUE REFERENCES tracking_accounts(id) ON DELETE CASCADE,
  phone_number VARCHAR(30),
  sim_provider VARCHAR(100),
  sim_country VARCHAR(100),
  sim_type VARCHAR(20) NOT NULL DEFAULT 'physical' CHECK (sim_type IN ('physical', 'esim')),
  two_fa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  recovery_status VARCHAR(20) NOT NULL DEFAULT 'unknown'
    CHECK (recovery_status IN ('unknown', 'verified', 'unverified', 'locked')),
  sim_status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (sim_status IN ('active', 'inactive', 'lost', 'blocked')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Security (encrypted via utils/sessionCrypto.js, 1:1) ------------------
CREATE TABLE IF NOT EXISTS tracking_account_security (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL UNIQUE REFERENCES tracking_accounts(id) ON DELETE CASCADE,
  two_fa_password_encrypted TEXT,
  two_fa_hint_encrypted TEXT,
  recovery_email_encrypted TEXT,
  security_notes_encrypted TEXT,
  password_changed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Purchase Information (1:1) ---------------------------------------------
CREATE TABLE IF NOT EXISTS tracking_account_purchase_info (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL UNIQUE REFERENCES tracking_accounts(id) ON DELETE CASCADE,
  source VARCHAR(100),
  supplier_name VARCHAR(200),
  supplier_contact VARCHAR(200),
  purchase_price NUMERIC(12, 2),
  purchase_date TIMESTAMPTZ,
  order_id VARCHAR(100),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tracking_purchase_supplier ON tracking_account_purchase_info(supplier_name);
CREATE INDEX IF NOT EXISTS idx_tracking_purchase_date ON tracking_account_purchase_info(purchase_date);

-- 7b. Telegram account metadata (1:1) — passive record-keeping fields
--     extracted from a paired session-info JSON (session-selling-tool
--     export format), never obtained by logging into the account.
CREATE TABLE IF NOT EXISTS tracking_account_telegram_meta (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL UNIQUE REFERENCES tracking_accounts(id) ON DELETE CASCADE,
  telegram_role VARCHAR(50),
  date_of_birth DATE,
  date_of_birth_verified BOOLEAN,
  premium_expires_at TIMESTAMPTZ,
  spamblock_status VARCHAR(50),
  spamblock_until TIMESTAMPTZ,
  has_profile_pic BOOLEAN NOT NULL DEFAULT FALSE,
  stats_spam_count INTEGER NOT NULL DEFAULT 0,
  stats_invites_count INTEGER NOT NULL DEFAULT 0,
  extra_params JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. Sales (1:many — history-capable for a future buy-back/resell; today
--    the app writes at most one row per account, the "current" sale is the
--    latest by sale_date) -----------------------------------------------
CREATE TABLE IF NOT EXISTS tracking_account_sales (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES tracking_accounts(id) ON DELETE CASCADE,
  buyer_name VARCHAR(200),
  buyer_telegram_username VARCHAR(100),
  buyer_telegram_id BIGINT,
  buyer_contact VARCHAR(200),
  sale_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sale_price NUMERIC(12, 2) NOT NULL,
  payment_method VARCHAR(20) NOT NULL DEFAULT 'other'
    CHECK (payment_method IN ('crypto', 'bank_transfer', 'paypal', 'cash', 'other')),
  payment_status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'paid', 'partial', 'refunded', 'disputed')),
  invoice_number VARCHAR(100),
  notes TEXT,
  sold_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tracking_sales_account_id ON tracking_account_sales(account_id);
CREATE INDEX IF NOT EXISTS idx_tracking_sales_sale_date ON tracking_account_sales(sale_date);
CREATE INDEX IF NOT EXISTS idx_tracking_sales_payment_status ON tracking_account_sales(payment_status);

-- 9. Assignments (append-only history, many:1 — rows are never deleted) ----
CREATE TABLE IF NOT EXISTS tracking_assignments (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES tracking_accounts(id) ON DELETE CASCADE,
  assigned_to_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_to_name VARCHAR(200),
  assigned_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  returned_date TIMESTAMPTZ,
  assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tracking_assignments_account_id ON tracking_assignments(account_id);
CREATE INDEX IF NOT EXISTS idx_tracking_assignments_open ON tracking_assignments(account_id) WHERE returned_date IS NULL;

-- 10. Notes (many:1, unlimited, timestamped) -------------------------------
CREATE TABLE IF NOT EXISTS tracking_notes (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES tracking_accounts(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tracking_notes_account_id ON tracking_notes(account_id);

-- 11. Tags (catalog + many:many junction) ----------------------------------
CREATE TABLE IF NOT EXISTS tracking_tags (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  color VARCHAR(20),
  is_suggested BOOLEAN NOT NULL DEFAULT FALSE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS tracking_account_tags (
  account_id INTEGER NOT NULL REFERENCES tracking_accounts(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tracking_tags(id) ON DELETE CASCADE,
  tagged_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_tracking_account_tags_tag_id ON tracking_account_tags(tag_id);

INSERT INTO tracking_tags (name, is_suggested) VALUES
  ('VIP', TRUE),
  ('Fresh', TRUE),
  ('Premium', TRUE),
  ('High Value', TRUE),
  ('Reserved', TRUE),
  ('Risky', TRUE),
  ('Personal', TRUE),
  ('Business', TRUE),
  ('Old', TRUE),
  ('New', TRUE)
ON CONFLICT (name) DO NOTHING;

-- Activity/audit trail reuses the existing activity_logs table (see
-- reportService.logActivity + the new tracking_* action strings added to
-- its VALID_ACTIONS whitelist) — no new table needed for that.
