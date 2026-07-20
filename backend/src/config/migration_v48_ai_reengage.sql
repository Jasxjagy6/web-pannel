-- migration_v48_ai_reengage.sql
-- Re-engagement ("keep user engaged") nudge state for the AI auto-responder.
-- One JSONB blob per chat memory row: { count, lastNudgeAt, thresholdMs }.
-- Additive + nullable so it is safe to re-run.
ALTER TABLE ai_chat_memories
  ADD COLUMN IF NOT EXISTS reengage JSONB;
