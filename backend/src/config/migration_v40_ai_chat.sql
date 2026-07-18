-- migration_v40_ai_chat.sql
--
-- AI auto-responder tables for Telegram sessions.
-- Provides per-session master toggle, per-chat override, rolling
-- conversation memory, and audit logging for CupidBot API calls.
-- Instagram is explicitly out of scope.

-- Master on/off switch and default config for each Telegram session.
CREATE TABLE IF NOT EXISTS ai_session_settings (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_session_settings_session_id
  ON ai_session_settings(session_id);
CREATE INDEX IF NOT EXISTS idx_ai_session_settings_enabled
  ON ai_session_settings(enabled);

-- Per-chat override inside a session.  enabled=TRUE is the default
-- behaviour when no row exists, so operators can selectively disable
-- individual chats without enumerating every allowed chat first.
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

CREATE INDEX IF NOT EXISTS idx_ai_chat_settings_session_id
  ON ai_chat_settings(session_id);
CREATE INDEX IF NOT EXISTS idx_ai_chat_settings_peer
  ON ai_chat_settings(session_id, peer_type, peer_id);

-- Rolling conversation memory per (session, chat).  messages is a JSONB
-- array ordered by insertion; trimming to the configured window happens
-- in application code on every append.
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

CREATE INDEX IF NOT EXISTS idx_ai_chat_memories_session_id
  ON ai_chat_memories(session_id);
CREATE INDEX IF NOT EXISTS idx_ai_chat_memories_peer
  ON ai_chat_memories(session_id, peer_type, peer_id);
CREATE INDEX IF NOT EXISTS idx_ai_chat_memories_last_incoming
  ON ai_chat_memories(last_incoming_at);

-- Audit trail for every CupidBot request/response and any failures.
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

CREATE INDEX IF NOT EXISTS idx_ai_response_logs_session_id
  ON ai_response_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_ai_response_logs_created_at
  ON ai_response_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_response_logs_status
  ON ai_response_logs(status);
