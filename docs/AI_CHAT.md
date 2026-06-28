# AI Auto-Responder (Telegram + CupidBot)

The AI auto-responder monitors every logged-in Telegram session and automatically replies to incoming messages using the [CupidBot](https://www.cupidbotofm.ai/x) downstream chat-generation API.

## Quick start

1. Get a CupidBot access token from https://cupidbot.web.app (API route uses normal credits).
2. Set it in `backend/.env`:
   ```
   CUPIDBOT_ACCESS_TOKEN=your_token_here
   ```
3. Run migrations:
   ```bash
   cd backend && npm run db:migrate
   ```
4. Restart the backend.
5. Open **AI Chat** in the Telegram panel sidebar.
6. Toggle AI ON for any logged-in session.
7. Send a message to that account from another Telegram user — the AI replies within the configured delay.

## Per-session and per-chat control

- **Session toggle** on the AI Chat page enables/disables AI for the whole account.
- **Per-chat overrides** in the expanded session card let you disable AI for specific chats.
- When no per-chat override exists, AI defaults to ON for every chat in an enabled session.

## Memory

Conversation history is stored in `ai_chat_memories` keyed by `(session_id, peer_type, peer_id)`. The rolling window is trimmed to `AI_MEMORY_MESSAGE_LIMIT` (default 50) messages. Use the trash icon in the AI Chat page to clear memory for a chat.

## Configuration

| Environment variable | Default | Description |
|----------------------|---------|-------------|
| `CUPIDBOT_ACCESS_TOKEN` | — | Required. CupidBot API access token. |
| `CUPIDBOT_ENDPOINT_URL` | `https://chat-api.cupidbotofm.ai/api/generateChatResponse` | Chat generation endpoint. |
| `CUPIDBOT_CONCURRENCY` | `5` | BullMQ worker concurrency. |
| `AI_REPLY_DELAY_MS` | `3000` | Base delay before sending a reply. |
| `AI_REPLY_JITTER_MS` | `2000` | Random extra delay added to the base delay. |
| `AI_MEMORY_MESSAGE_LIMIT` | `50` | Max messages kept per chat. |
| `AI_LOG_RETENTION_HOURS` | `720` (30 days) | `ai_response_logs` retention. |

## Architecture

- `services/aiSessionManager.js` attaches a persistent GramJS `NewMessage` listener to every connected Telegram session.
- `services/aiChatService.js` decides whether to handle an incoming message, persists it to memory, and enqueues a BullMQ job.
- `workers/aiChatWorker.js` calls CupidBot, sends the reply through GramJS, and logs the result.
- `services/cupidbotService.js` wraps the CupidBot HTTP API with retry/backoff.
- `services/aiMemoryService.js` manages per-chat rolling memory in PostgreSQL.

## Database tables

- `ai_session_settings` — master toggle and config per session.
- `ai_chat_settings` — per-chat override.
- `ai_chat_memories` — rolling message window.
- `ai_response_logs` — audit trail of every CupidBot request/response.

## Scope

- **Telegram only.** No Instagram support.
- **No Telegram Bot API or Telegram Premium bulk-reply features.** Replies are sent through the logged-in user account's normal MTProto flow.
