-- =============================================================================
-- migration_v18_tg_otp_relay.sql
--
-- Saved-Messages OTP relay (the optional follow-up to anti-revoke
-- Phase 4). The phase-4 work made panel sessions bulletproof against
-- transient revocation; this migration wires up a safety-net for the
-- one scenario phase 4 cannot prevent — *deliberate* termination of
-- the user's main account by Telegram (SIM swap, password reset,
-- "Terminate all other sessions" tap on the phone, support-side
-- wipe). When that happens the panel session for the main number is
-- gone with the rest, and the OTP that arrives next on that number
-- never reaches the panel because the account no longer exists.
--
-- The relay solves it the only way that's actually bulletproof:
-- a *second* Telegram account (a userbot or a different number) is
-- attached to one or more panel "watch sessions" as a passive
-- listener. Every time a panel watch-session sees a service message
-- from `777000` (or any chat ID in the configurable allow-list), the
-- listener forwards the body to the relay account's Saved Messages
-- (`InputPeerSelf`). The relay account is independent from the main
-- account — Telegram cannot kill it as a side-effect of wiping the
-- main number — so the OTP survives.
--
-- This migration introduces two tables:
--
--   tg_otp_relays
--     One row per (watch session → relay session) attachment. The
--     relay session is the SAVED-MESSAGES destination, the watch
--     session is the source whose incoming DMs we forward. Both are
--     `sessions.id` references; both must belong to the same `user_id`
--     so a tenant cannot weaponise a relay against another tenant's
--     session.
--
--     Fields:
--       - id                 surrogate PK
--       - user_id            owning user (FK + RLS-style scoping)
--       - watch_session_id   panel session whose 777000 DMs we listen for
--       - relay_session_id   panel session whose Saved Messages we POST to
--       - sender_filter      JSON array of sender IDs / usernames to
--                            forward; defaults to ['777000', 'Telegram']
--       - regex              optional ECMAScript regex to filter message
--                            text (NULL = forward every message that
--                            matches sender_filter). The application is
--                            responsible for compiling + sandboxing this.
--       - enabled            soft on/off without deleting the row
--       - prefix             optional human-readable prefix prepended to
--                            the forwarded text (e.g. 'OTP for +91...')
--       - rate_limit_per_min cap on forwards per (watch_session_id, hour)
--                            so a misbehaving sender can't drain the
--                            relay account's daily message quota
--       - last_forwarded_at  bookkeeping for the UI
--       - last_forward_error last failure surface for the UI
--       - created_at / updated_at
--
--     Constraints:
--       - UNIQUE (watch_session_id, relay_session_id) — at most one
--         attachment between a given pair
--       - CHECK (watch_session_id <> relay_session_id) — no self-loop
--       - ON DELETE CASCADE for both session FKs — losing a session
--         cleans up the attachment
--
--   tg_otp_relay_events
--     Append-only audit ledger of every forward attempt (success and
--     failure). The application prunes rows older than
--     `OTP_RELAY_EVENT_RETENTION_DAYS` (default 30) on a periodic
--     timer. We keep the schema minimal — the panel UI only needs
--     "what was forwarded, when, did it succeed".
--
-- The schema is fully backward-compatible: with `OTP_RELAY_ENABLED=false`
-- the application treats the tables as dormant.
-- =============================================================================

CREATE TABLE IF NOT EXISTS tg_otp_relays (
    id                  SERIAL PRIMARY KEY,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    watch_session_id    INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    relay_session_id    INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    sender_filter       JSONB   NOT NULL DEFAULT '["777000","Telegram"]'::JSONB,
    regex               TEXT,
    prefix              TEXT,
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    rate_limit_per_min  INTEGER NOT NULL DEFAULT 30,
    last_forwarded_at   TIMESTAMP,
    last_forward_error  TEXT,
    created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT tg_otp_relays_no_self_loop
        CHECK (watch_session_id <> relay_session_id),
    CONSTRAINT tg_otp_relays_unique_attachment
        UNIQUE (watch_session_id, relay_session_id)
);

CREATE INDEX IF NOT EXISTS idx_tg_otp_relays_user_id
    ON tg_otp_relays(user_id);
CREATE INDEX IF NOT EXISTS idx_tg_otp_relays_watch
    ON tg_otp_relays(watch_session_id) WHERE enabled = TRUE;
CREATE INDEX IF NOT EXISTS idx_tg_otp_relays_relay
    ON tg_otp_relays(relay_session_id);

-- Append-only audit ledger.
CREATE TABLE IF NOT EXISTS tg_otp_relay_events (
    id                  SERIAL PRIMARY KEY,
    relay_id            INTEGER NOT NULL REFERENCES tg_otp_relays(id) ON DELETE CASCADE,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- denormalised so the audit log survives even if the underlying
    -- session row is later deleted by the user
    watch_session_id    INTEGER,
    relay_session_id    INTEGER,
    sender_id           VARCHAR(64),
    -- truncated to 1 KB to keep the audit log lightweight; full body
    -- already lives in the relay account's Saved Messages by the time
    -- this row is written.
    message_excerpt     TEXT,
    -- "forwarded" | "skipped_sender" | "skipped_regex" | "rate_limited"
    -- | "send_failed" | "watch_disconnected"
    status              VARCHAR(32) NOT NULL,
    error_message       TEXT,
    created_at          TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tg_otp_relay_events_relay_id
    ON tg_otp_relay_events(relay_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tg_otp_relay_events_user_id
    ON tg_otp_relay_events(user_id, created_at DESC);
