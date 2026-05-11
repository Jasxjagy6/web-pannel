-- v27 — clear stale hardcoded PEER_FLOOD cooldowns.
--
-- Why this migration exists:
--
-- Earlier revisions of `sessionCooldown.markPeerFlood(...)` applied a
-- hardcoded 6-hour (21600s) panel-side cooldown whenever Telegram returned
-- the `PEER_FLOOD` error. PEER_FLOOD does not include a duration — Telegram
-- never tells the client how long the account is restricted — so this 6h
-- value was an invention of the panel. Operators saw a uniform "~5h
-- remaining" cooldown badge on every session that had ever triggered
-- PEER_FLOOD and were locked out of group-add / bulk-message jobs even
-- though Telegram itself was no longer flagging anything.
--
-- The service has been updated so PEER_FLOOD no longer applies a panel-side
-- cooldown by default (set `PEER_FLOOD_COOLDOWN_SECONDS=<seconds>` to opt
-- back in). This migration unblocks already-locked sessions by clearing the
-- cooldown rows that match the old hardcoded pattern exactly:
--
--   cooldown_reason   = 'PEER_FLOOD'
--   cooldown_seconds  = 21600       -- the legacy 6h hardcoded value
--   cooldown_until    > NOW()       -- only future-dated rows
--
-- Legitimate `FLOOD_WAIT_N` cooldowns (which carry a real
-- Telegram-supplied duration) use a different `cooldown_seconds` and are
-- left untouched.

UPDATE sessions
SET    cooldown_until   = NULL,
       cooldown_reason  = NULL,
       cooldown_set_at  = NULL,
       cooldown_seconds = NULL
WHERE  cooldown_reason  = 'PEER_FLOOD'
  AND  cooldown_seconds = 21600
  AND  cooldown_until IS NOT NULL
  AND  cooldown_until > NOW();
