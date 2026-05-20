-- =============================================================================
-- Migration v37 — Reddit cookie scraper
-- =============================================================================
-- Reddit cookie-scraper feature. Lives under the Telegram panel as a
-- cross-platform OSINT-style tool (it is NOT a Telegram feature — it
-- just shares the panel chrome). Stores credentials encrypted at rest
-- and captures all cookies / OAuth tokens emitted during a real Reddit
-- login flow.
--
-- All statements are idempotent so the migration is safe to re-run.
-- =============================================================================

-- 1. reddit_accounts ---------------------------------------------------------
-- One row per Reddit account the operator wants to manage. The password
-- is encrypted with AES-256-GCM using the panel-wide encryption key
-- (utils/crypto.js). The TOTP shared secret (base32) is stored
-- encrypted next to the password so the worker can solve 2FA at login
-- time without prompting.
CREATE TABLE IF NOT EXISTS reddit_accounts (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username            VARCHAR(64) NOT NULL,
  password_enc        TEXT        NOT NULL,
  totp_secret_enc     TEXT,
  label               VARCHAR(120),
  notes               TEXT,
  proxy_id            INTEGER REFERENCES proxies(id) ON DELETE SET NULL,
  status              VARCHAR(24) NOT NULL DEFAULT 'idle',
    -- idle | queued | scraping | ok | error | locked | needs_2fa | needs_captcha
  status_message      TEXT,
  last_scraped_at     TIMESTAMP,
  last_successful_at  TIMESTAMP,
  last_job_id         INTEGER,
  metadata            JSONB       NOT NULL DEFAULT '{}'::jsonb,
    -- profile snapshot: { id, name, link_karma, comment_karma, created_utc,
    --                     has_verified_email, is_gold, is_mod, oauth_token_present }
  created_at          TIMESTAMP   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP   NOT NULL DEFAULT NOW()
);

-- Expression-based unique index: enforces one row per (user_id, lowercase
-- username) so the same Reddit account can't be added twice to an
-- operator's panel, regardless of the casing they typed.
CREATE UNIQUE INDEX IF NOT EXISTS reddit_accounts_user_username_uq
  ON reddit_accounts (user_id, lower(username));

CREATE INDEX IF NOT EXISTS idx_reddit_accounts_user
  ON reddit_accounts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reddit_accounts_status
  ON reddit_accounts (status);
CREATE INDEX IF NOT EXISTS idx_reddit_accounts_username_l
  ON reddit_accounts (lower(username));

-- 2. reddit_scrape_jobs ------------------------------------------------------
-- One row per scrape attempt. We never delete these — they form the
-- audit trail (operator + IP + UA + outcome).
CREATE TABLE IF NOT EXISTS reddit_scrape_jobs (
  id                  SERIAL PRIMARY KEY,
  account_id          INTEGER NOT NULL REFERENCES reddit_accounts(id) ON DELETE CASCADE,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status              VARCHAR(24) NOT NULL DEFAULT 'queued',
    -- queued | running | succeeded | failed | cancelled
  attempt             SMALLINT    NOT NULL DEFAULT 1,
  proxy_id            INTEGER REFERENCES proxies(id) ON DELETE SET NULL,
  proxy_url_snapshot  TEXT,
  user_agent          TEXT,
  client_ip           VARCHAR(64),
  cookies_count       INTEGER     NOT NULL DEFAULT 0,
  oauth_token_present BOOLEAN     NOT NULL DEFAULT FALSE,
  meta_snapshot       JSONB       NOT NULL DEFAULT '{}'::jsonb,
    -- { reddit_session_set: bool, modhash_set: bool, hosts_visited: [..],
    --   me_endpoint: { ok, link_karma, comment_karma, id, name } }
  duration_ms         INTEGER,
  error_code          VARCHAR(48),
  error_message       TEXT,
  queue_job_id        VARCHAR(64),
  created_at          TIMESTAMP   NOT NULL DEFAULT NOW(),
  started_at          TIMESTAMP,
  completed_at        TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_reddit_jobs_account
  ON reddit_scrape_jobs (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reddit_jobs_user
  ON reddit_scrape_jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reddit_jobs_status
  ON reddit_scrape_jobs (status);

-- 3. reddit_cookies ----------------------------------------------------------
-- One row per captured cookie. The cookie VALUE is encrypted at rest;
-- everything else (name, domain, path, attrs) is plaintext so the
-- export endpoints can stream large numbers of rows without paying
-- crypto cost on every field.
--
-- Multiple scrape jobs of the same account append new rows — the
-- export endpoints filter by "latest job per account" by default, but
-- the history is preserved for forensic comparison.
CREATE TABLE IF NOT EXISTS reddit_cookies (
  id            SERIAL PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES reddit_accounts(id) ON DELETE CASCADE,
  job_id        INTEGER NOT NULL REFERENCES reddit_scrape_jobs(id) ON DELETE CASCADE,
  name          VARCHAR(190) NOT NULL,
  value_enc     TEXT         NOT NULL,
  value_hash    VARCHAR(64)  NOT NULL,  -- sha256(value) for dedup/compare
  value_len     INTEGER      NOT NULL,
  domain        VARCHAR(190) NOT NULL,
  path          VARCHAR(190) NOT NULL DEFAULT '/',
  expires_at    TIMESTAMP,
  max_age       INTEGER,
  http_only     BOOLEAN      NOT NULL DEFAULT FALSE,
  secure        BOOLEAN      NOT NULL DEFAULT FALSE,
  same_site     VARCHAR(16),     -- 'Strict' | 'Lax' | 'None' | NULL
  host_only     BOOLEAN      NOT NULL DEFAULT FALSE,
  source_url    TEXT,            -- the URL that emitted the Set-Cookie header
  set_cookie    TEXT,            -- original Set-Cookie header for forensic replay
  captured_at   TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reddit_cookies_job
  ON reddit_cookies (job_id);
CREATE INDEX IF NOT EXISTS idx_reddit_cookies_account
  ON reddit_cookies (account_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_reddit_cookies_name
  ON reddit_cookies (lower(name));
