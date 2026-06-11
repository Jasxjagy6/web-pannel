-- Migration: Add tables for Session Login Email setup jobs
-- This feature allows bulk-adding login emails to Telegram sessions.

BEGIN;

CREATE TABLE IF NOT EXISTS login_email_jobs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, running, completed, cancelled
    total_sessions INTEGER NOT NULL DEFAULT 0,
    succeeded_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    cancel_requested BOOLEAN NOT NULL DEFAULT false,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    started_at TIMESTAMP WITH TIME ZONE,
    finished_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_login_email_jobs_user_id ON login_email_jobs(user_id);

CREATE TABLE IF NOT EXISTS login_email_job_items (
    id SERIAL PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES login_email_jobs(id) ON DELETE CASCADE,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    imap_password VARCHAR(255) NOT NULL,
    imap_host VARCHAR(255) NOT NULL,
    imap_port INTEGER NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, requesting_code, waiting_for_email, verifying, completed, failed
    error_code VARCHAR(100),
    error_message TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    started_at TIMESTAMP WITH TIME ZONE,
    finished_at TIMESTAMP WITH TIME ZONE,
    UNIQUE(job_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_login_email_job_items_job_id ON login_email_job_items(job_id);
CREATE INDEX IF NOT EXISTS idx_login_email_job_items_session_id ON login_email_job_items(session_id);

COMMIT;
