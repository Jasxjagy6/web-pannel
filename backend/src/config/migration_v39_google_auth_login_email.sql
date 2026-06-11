-- Migration: Add tables for Gmail Accounts and update jobs
-- This feature uses Google OAuth to read OTP for Telegram login email

BEGIN;

CREATE TABLE IF NOT EXISTS gmail_accounts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expiry_date BIGINT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, email)
);

ALTER TABLE login_email_job_items DROP COLUMN IF EXISTS imap_password;
ALTER TABLE login_email_job_items DROP COLUMN IF EXISTS imap_host;
ALTER TABLE login_email_job_items DROP COLUMN IF EXISTS imap_port;
ALTER TABLE login_email_job_items ADD COLUMN IF NOT EXISTS gmail_account_id INTEGER REFERENCES gmail_accounts(id) ON DELETE SET NULL;

COMMIT;
