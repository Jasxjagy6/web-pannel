-- migration_v42_ai_chat_conversation_state.sql
--
-- Add conversation state tracking for CupidBot API integration.
-- CupidBot requires us to track which AI messages were confirmed delivered
-- and store recipient profile info for better AI context.

-- Add recipient_profile column for storing bio, location, etc.
ALTER TABLE ai_chat_memories
  ADD COLUMN IF NOT EXISTS recipient_profile JSONB;

-- Add index for faster profile lookups
CREATE INDEX IF NOT EXISTS idx_ai_chat_memories_recipient_profile
  ON ai_chat_memories(recipient_profile)
  WHERE recipient_profile IS NOT NULL;

-- The messages JSONB array now stores a 'confirmed' boolean on outgoing messages
-- to track which AI messages have been confirmed as delivered to CupidBot.
-- This is handled in application code, no schema change needed for messages array.

-- Add column to track last confirmed outgoing message timestamp
ALTER TABLE ai_chat_memories
  ADD COLUMN IF NOT EXISTS last_confirmed_outgoing_at TIMESTAMPTZ;

-- Add column to track conversation state for isFollowUp logic
ALTER TABLE ai_chat_memories
  ADD COLUMN IF NOT EXISTS last_exchange_at TIMESTAMPTZ;

-- Add column to store the last incoming message ID for isFollowUp
ALTER TABLE ai_chat_memories
  ADD COLUMN IF NOT EXISTS last_incoming_msg_id BIGINT;

-- Add column to store the last outgoing message ID that was sent to CupidBot
ALTER TABLE ai_chat_memories
  ADD COLUMN IF NOT EXISTS last_outgoing_msg_id BIGINT;

COMMENT ON COLUMN ai_chat_memories.recipient_profile IS 'JSONB: {bio, location, username, firstName, lastName} for CupidBot context';
COMMENT ON COLUMN ai_chat_memories.last_confirmed_outgoing_at IS 'Timestamp of last AI message confirmed delivered to recipient';
COMMENT ON COLUMN ai_chat_memories.last_exchange_at IS 'Timestamp of last message exchange (incoming or outgoing)';
COMMENT ON COLUMN ai_chat_memories.last_incoming_msg_id IS 'Telegram message ID of last incoming message for isFollowUp tracking';
COMMENT ON COLUMN ai_chat_memories.last_outgoing_msg_id IS 'Telegram message ID of last outgoing AI message sent to CupidBot';