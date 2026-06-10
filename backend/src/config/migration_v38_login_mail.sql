-- migration_v38_login_mail.sql
-- Login-mail feature: set a login email on Telegram sessions with
-- automated OTP reading from the email inbox via IMAP.
--
-- Three tables:
--   login_mail_credentials  — encrypted IMAP credentials per user
--   login_mail_jobs         — bulk job header (one per "Apply" click)
--   login_mail_job_items    — per-session outcome inside a job

-- ---------------------------------------------------------------------
-- login_mail_credentials
-- Stores IMAP connection details so the panel can auto-read Telegram
-- verification codes from the user's inbox. Password is encrypted at
-- rest using the same AES-256-GCM helper the session strings use.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS login_mail_credentials (
  id                          BIGSERIAL    PRIMARY KEY,
  user_id                     INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email                       VARCHAR(254) NOT NULL,
  imap_host                   VARCHAR(255) NOT NULL,
  imap_port                   INTEGER      NOT NULL DEFAULT 993,
  imap_user                   VARCHAR(254) NOT NULL,
  imap_pass_encrypted         TEXT         NOT NULL,
  use_tls                     BOOLEAN      NOT NULL DEFAULT TRUE,
  label                       VARCHAR(100),
  last_tested_at              TIMESTAMP,
  last_test_ok                BOOLEAN,
  created_at                  TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMP    NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, email)
);

CREATE INDEX IF NOT EXISTS idx_login_mail_creds_user
  ON login_mail_credentials(user_id);

-- ---------------------------------------------------------------------
-- login_mail_jobs
-- Tracks a bulk "set login email" request across N sessions.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS login_mail_jobs (
  id                BIGSERIAL    PRIMARY KEY,
  user_id           INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id     BIGINT       REFERENCES login_mail_credentials(id) ON DELETE SET NULL,
  email             VARCHAR(254) NOT NULL,
  -- pending | running | completed | failed | cancelled
  status            VARCHAR(20)  NOT NULL DEFAULT 'pending',
  total_sessions    INTEGER      NOT NULL DEFAULT 0,
  succeeded_count   INTEGER      NOT NULL DEFAULT 0,
  failed_count      INTEGER      NOT NULL DEFAULT 0,
  skipped_count     INTEGER      NOT NULL DEFAULT 0,
  error_message     TEXT,
  cancel_requested  BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMP    NOT NULL DEFAULT NOW(),
  started_at        TIMESTAMP,
  finished_at       TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_login_mail_jobs_user
  ON login_mail_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_mail_jobs_status
  ON login_mail_jobs(status) WHERE status IN ('pending','running');

-- ---------------------------------------------------------------------
-- login_mail_job_items
-- Per-session result for a login-mail job.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS login_mail_job_items (
  id              BIGSERIAL    PRIMARY KEY,
  job_id          BIGINT       NOT NULL REFERENCES login_mail_jobs(id) ON DELETE CASCADE,
  session_id      INTEGER      NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  -- pending | running | succeeded | failed | skipped
  status          VARCHAR(20)  NOT NULL DEFAULT 'pending',
  error_code      VARCHAR(64),
  error_message   TEXT,
  attempts        INTEGER      NOT NULL DEFAULT 0,
  started_at      TIMESTAMP,
  finished_at     TIMESTAMP,
  UNIQUE(job_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_login_mail_items_job
  ON login_mail_job_items(job_id, status);
CREATE INDEX IF NOT EXISTS idx_login_mail_items_session
  ON login_mail_job_items(session_id);
