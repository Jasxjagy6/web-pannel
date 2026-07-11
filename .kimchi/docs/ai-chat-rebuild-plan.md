# AI Chat Auto-Responder — Rebuild Plan

## Current State

The backend has a nearly-complete AI auto-responder built around CupidBot:
- `aiChatService.handleIncomingMessage` receives GramJS `NewMessage` events.
- It persists messages to `ai_chat_memories` and enqueues a BullMQ job.
- `aiChatWorker` calls CupidBot and sends the reply via `telegramService.sendMessage`.

It is **not working in practice** because of the following bugs and missing pieces:

1. **CupidBot env key is gated to `userId === 1`** — only the first DB user can use the env-supplied `CUPIDBOT_ACCESS_TOKEN`. Other admins/users must store their own key, which fails validation if the env key is the only one configured.
2. **Hard-coded DM-only mode** — `_mergeConfig` forces `allowedPeerTypes: ['user']`, `allowGroups: false`, `allowChannels: false`. Users cannot enable AI for groups/channels even though the UI, routes, and schema support them.
3. **Memory window is 50, not 100** — the user explicitly wants the AI to read the previous 100 messages before replying.
4. **Memory is one-way** — messages sent from the panel UI are broadcast over Socket.IO but are never appended to `ai_chat_memories`, so the AI replies as if those outgoing messages never happened.
5. **No memory seeding** — when AI is enabled for an existing chat, memory starts empty. The AI cannot "understand previous 100 messages" that arrived before the toggle.
6. **AI listener attachment is best-effort / fragile** — `sessionService` and the heartbeat attach with `.catch(() => {})`. If a session reconnects, the listener may silently fail and never re-attach.
7. **Per-chat config is ignored at runtime** — `handleIncomingMessage` only merges session-level config; per-chat `ai_chat_settings.config` is never applied.
8. **Frontend API imports are missing** — `AiChat.jsx` calls `getCupidbotKey`, `setCupidbotKey`, `deleteCupidbotKey` but does not import them.
9. **Frontend dialogs are filtered to personal chats only** — `telegramClientService.getDialogs` returns `personalOnly`, so groups/channels never appear in the AI chat list even after backend group support is enabled.
10. **No visibility into why replies fail** — `ai_response_logs` exists but does not surface CupidBot `rateLimit`, raw HTTP status, or whether the session was connected when the job ran.

## Goal

Make the AI auto-responder production-ready for an institutional Telegram panel:
- Works for **multiple active sessions** simultaneously.
- Works for **multiple chats per session** (DMs, basic groups, supergroups, channels).
- AI replies only when enabled for the session **and** the chat.
- AI reads the **last 100 messages** of memory before every reply.
- Panel-sent messages are included in memory.
- Existing chat history can be seeded into memory when AI is first enabled.
- Env-supplied CupidBot key is usable by admins/owners.
- Robust listener lifecycle (attach on login, re-attach on heartbeat reconnect, detach on logout/disconnect).
- Better observability in logs and the `ai_response_logs` table.

## Architecture Decisions

1. **Keep the same queue-based design** — GramJS update loop must stay non-blocking.
2. **Use the existing `ai_chat_memories` table** as the single source of truth.
3. **Do not add new dependencies** — only use `pg`, `bullmq`, `telegram`, Node built-ins already present.
4. **Config inheritance**: session default config → per-chat override config. Chat-level `enabled` can disable a chat even when session AI is on.
5. **Peer-type support is controlled by config**, not hard-coded off. Default remains `['user']` for safety, but an operator can change it via the config object (and the UI can expose toggles later). For now the backend honours whatever `allowedPeerTypes`, `allowGroups`, `allowChannels` the stored config contains.
6. **Env key fallback**: any user with `role IN ('admin', 'superadmin')` may fall back to `CUPIDBOT_ACCESS_TOKEN`. Non-admin users still need a per-user key.
7. **Listener lifecycle**: centralise attachment in `aiSessionManager`, add explicit re-attach on heartbeat reconnect, and make `setSessionEnabled` fail loudly if the listener cannot attach.
8. **Memory seeding**: add a service method that fetches up to 100 historical messages from GramJS and writes them into `ai_chat_memories`, preserving direction (`out`). Expose an optional `seedMemory=true` flag on the enable endpoint and trigger it automatically when a chat override is created with no prior memory.

## Files to Change

### Backend

1. `backend/src/services/cupidbotService.js`
2. `backend/src/services/aiChatService.js`
3. `backend/src/services/aiSessionManager.js`
4. `backend/src/services/aiMemoryService.js`
5. `backend/src/services/telegramClientService.js`
6. `backend/src/services/sessionService.js`
7. `backend/src/workers/aiChatWorker.js`
8. `backend/src/controllers/aiChatController.js`
9. `backend/src/routes/aiChat.js`

### Frontend

10. `frontend/src/pages/AiChat.jsx`
11. `frontend/src/api/aiChat.js` (if new endpoints are needed)

## Chunk Breakdown

### Chunk 1 — CupidBot key resolution & validation
**Files:** `cupidbotService.js`, `aiChatController.js`
**Complexity:** simple
- Change `getAccessToken(userId)` to fall back to `CUPIDBOT_ACCESS_TOKEN` for any admin/superadmin user (read `users.role`). Keep the existing per-user key precedence.
- Update `getCupidbotKey` controller to report `isAdmin` for admins based on role, not only `userId === 1`.
- Validate env key on first use with a short-lived cached result so boot is not delayed.

### Chunk 2 — Config merge & peer-type support
**Files:** `aiChatService.js`
**Complexity:** simple
- Remove the forced override of `allowedPeerTypes`, `allowGroups`, `allowChannels` in `_mergeConfig`.
- Apply per-chat config override in `handleIncomingMessage`.
- Default config remains DM-only; stored config is honoured.

### Chunk 3a — 100-message memory and seeding
**Files:** `aiMemoryService.js`, `aiChatService.js`, `aiChatController.js`, `routes/aiChat.js`
**Complexity:** complex
- Bump `DEFAULT_MEMORY_LIMIT` to 100 and accept a config field.
- Add `aiMemoryService.seedFromHistory(sessionId, peerType, peerId, messages)` that bulk-inserts normalized messages into memory, preserving order and `out` direction.
- Add `aiChatService.seedChatMemory(sessionId, userId, peerType, peerId, opts)` that fetches up to 100 recent messages via `telegramClientService.getMessages` and seeds memory.
- Add REST endpoint `POST /sessions/:id/ai-chats/:peerType/:peerId/seed` and wire it to the controller.
- Trigger automatic seeding when a chat override is first enabled and its memory row is empty.

### Chunk 3b — Outgoing-message memory sync
**Files:** `telegramClientService.js`
**Complexity:** simple
- After a successful panel send (`sendMessage` and `sendMedia`), append an outgoing memory item to `ai_chat_memories` via `aiMemoryService.append`.
- Only append when AI is enabled for the session AND the chat is not explicitly disabled (read `ai_session_settings` and `ai_chat_settings`).

### Chunk 4 — Robust AI listener lifecycle
**Files:** `aiSessionManager.js`, `sessionService.js`, `aiChatService.js`
**Complexity:** complex
- `aiSessionManager.attach` must log errors, throw on real failures, and store the detach function keyed by session.
- Add `aiSessionManager.reattach(sessionId)` for heartbeat reconnects.
- In `sessionService.loginSession` and heartbeat paths, await `aiSessionManager.attach` and log failures instead of swallowing.
- In `aiChatService.setSessionEnabled`, await attach/detach and return error details so the UI can show why enable failed.

### Chunk 5 — Worker observability & correctness
**Files:** `aiChatWorker.js`
**Complexity:** simple
- Pass `userId` to `generateReply` (currently missing from worker call).
- Capture HTTP status / rate limit in `ai_response_logs`.
- Log a clear warning when `tgService.sendMessage` fails, including the CupidBot response.
- Ensure outgoing memory append happens even when `sendMessage` result lacks `messageId`.

### Chunk 6 — Frontend fixes
**Files:** `frontend/src/pages/AiChat.jsx`
**Complexity:** simple
- Add missing imports for `getCupidbotKey`, `setCupidbotKey`, `deleteCupidbotKey`.
- Optionally add a "Seed memory" button per chat that calls the new seed endpoint.
- Surface enable errors from the backend.

### Chunk 7 — Dialog peer-type filter for AI UI
**Files:** `backend/src/services/telegramClientService.js`
**Complexity:** simple
- Remove the `personalOnly` filter in `getDialogs` **when the caller is the AI settings flow**.
- Better: add an optional `includeAllPeerTypes` query param to the existing `/dialogs` route and controller; update the frontend AI page to pass it.

## Acceptance Criteria

1. A non-userId-1 admin with `CUPIDBOT_ACCESS_TOKEN` in env can call `GET /cupidbot-key` and see `hasKey: true, isValid: true, isAdmin: true`.
2. `aiChatService.setSessionEnabled(sessionId, userId, true)` attaches the GramJS listener and returns `{ attached: true }`; if attach fails it returns a 502 with the error.
3. Enabling session AI with config `{ allowedPeerTypes: ['user','chat','channel'], allowGroups: true, allowChannels: true }` allows AI to handle group and channel incoming messages.
4. Memory stores up to 100 messages and the worker sends the full window to CupidBot.
5. Sending a message via the panel UI appends an outgoing item to `ai_chat_memories` for the same peer.
6. The seed endpoint can backfill the last 100 messages into memory for any peer.
7. The frontend AI page loads the CupidBot key status and no longer throws `getCupidbotKey is not defined`.
8. The frontend AI page can list groups/channels so per-chat toggles work for them.

## Test Strategy

- The repo already has `backend/test/ai-chat/smoke.test.js`. After each backend chunk:
  1. Run `node -c` syntax check on every changed file.
  2. Run `node backend/test/ai-chat/smoke.test.js` to ensure modules still load.
  3. Add new smoke assertions for any new exported methods (e.g., `seedChatMemory`, `reattach`).
- Manual end-to-end checks: trigger the relevant REST route and inspect `ai_response_logs`.
- A final integration smoke run verifies the full chain: env key fallback, config merge, memory append, and queue worker load.

## Notes

- We will NOT add a webhook-based alternative in this rebuild; we will fix the existing GramJS long-poll path.
- We will NOT change the CupidBot payload schema except to keep it aligned with the current CupidBot docs.
- We will preserve backward compatibility for existing `ai_session_settings` rows.
