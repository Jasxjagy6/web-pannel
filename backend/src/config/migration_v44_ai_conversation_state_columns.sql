-- Add conversation state tracking columns to ai_chat_memories
-- Generic columns used by both CupidBot and CapitalBot providers
ALTER TABLE ai_chat_memories
  ADD COLUMN IF NOT EXISTS ai_conversation_state VARCHAR(50),
  ADD COLUMN IF NOT EXISTS last_ai_category VARCHAR(255),
  ADD COLUMN IF NOT EXISTS last_ai_response JSONB;

COMMENT ON COLUMN ai_chat_memories.ai_conversation_state IS 'Current conversation state (active/ghosted)';
COMMENT ON COLUMN ai_chat_memories.last_ai_category IS 'Last response category from AI provider';
COMMENT ON COLUMN ai_chat_memories.last_ai_response IS 'Last response metadata from AI provider';
