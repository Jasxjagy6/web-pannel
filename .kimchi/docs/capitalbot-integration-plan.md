# CapitalBot AI Integration Plan

## Overview
Add support for CapitalBot (capitalbot.ai) as a second AI provider alongside CupidBot in the Telegram panel. Users must be able to select which AI to use per session and enter the corresponding API key.

## Current Architecture
- **AI Providers**: Only CupidBot supported
- **API Key Storage**: `user_cupidbot_keys` table (per-user)
- **Session Config**: `ai_session_settings.config.cupidbot` object
- **Key Validation**: `cupidbotService.validateApiKey()`
- **Reply Generation**: `cupidbotService.generateReply()`
- **Queue Worker**: `aiChatWorker` calls CupidBot service
- **Frontend**: `AiChat.jsx` has CupidBot key input and validation

## Required Changes

### 1. Database Migration
Create `migration_vXX_user_capitalbot_keys.sql`:
```sql
CREATE TABLE IF NOT EXISTS user_capitalbot_keys (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  api_key VARCHAR(255) NOT NULL,
  is_valid BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_capitalbot_keys_user_id ON user_capitalbot_keys(user_id);
```

### 2. Backend Environment Variables
Add to `backend/.env.example`:
```
# CapitalBot AI Auto-Responder (Telegram only)
CAPITALBOT_ACCESS_TOKEN=
CAPITALBOT_ENDPOINT_URL=https://api.capitalbot.ai/v1/generateChatResponse
```

### 3. CapitalBot Service (`services/capitalbotService.js`)
Mirror `cupidbotService.js` with:
- `getAccessToken(userId)` - resolves user key or admin env fallback
- `setUserApiKey(userId, apiKey)` - validates and stores
- `deleteUserApiKey(userId)` - removes key
- `validateApiKey(apiKey)` - calls CapitalBot endpoint
- `generateReply({...})` - calls CapitalBot API with proper payload
- `parseResponseCategory(category)` - handle CapitalBot-specific categories

**Need to research CapitalBot API payload structure** - may differ from CupidBot.

### 4. AI Chat Service Updates (`services/aiChatService.js`)
- Add `provider` field to session config (default: 'cupidbot')
- Accept values: 'cupidbot' | 'capitalbot'
- Merge configs: `config.cupidbot` and `config.capitalbot` separately
- Pass `provider` to queue job data

### 5. AI Chat Controller Updates (`controllers/aiChatController.js`)
Add routes:
- `GET /capitalbot-key` - get key status
- `POST /capitalbot-key` - set/validate key
- `DELETE /capitalbot-key` - delete key

### 6. AI Chat Routes (`routes/aiChat.js`)
Add new routes for capitalbot key management.

### 7. AI Chat Worker (`workers/aiChatWorker.js`)
- Import `capitalbotService`
- In `processGenerateReply`, select service based on `config.provider` or `config.aiProvider`
- Call appropriate `generateReply()` method

### 8. Frontend API Client (`frontend/src/api/aiChat.js`)
Add exports:
- `getCapitalbotKey()`
- `setCapitalbotKey(apiKey)`
- `deleteCapitalbotKey()`

### 9. Frontend AI Chat Page (`frontend/src/pages/AiChat.jsx`)
Major UI changes:
- **Provider Selector**: Dropdown to choose AI provider (CupidBot / CapitalBot) per session
- **Key Management**: Show appropriate key input based on selected provider
- **Config Fields**: Provider-specific config options (chat style, persona, etc.)
- **Validation**: Validate key for selected provider

### 10. Database Schema Updates
Add `provider` column to `ai_session_settings` or keep in `config.provider` JSON field.

## Implementation Order

1. **Migration & Env** - Foundation
2. **CapitalBot Service** - Core API integration
3. **Backend Services/Controller/Routes** - Business logic
4. **Queue Worker** - Runtime execution
5. **Frontend API** - Client methods
6. **Frontend UI** - User interface

## CapitalBot API Research Needed

From capitalbot.ai website:
- "Full API access. REST API for custom integrations. Generate responses, analyze media, manage presets."
- "Full API documentation is available in the dashboard."
- Login with license key → configure persona → connect via REST API

**Assumption**: CapitalBot API likely similar to CupidBot with:
- POST endpoint for chat generation
- Access token / license key auth
- Similar payload structure (messages, recipient, persona config)

Will need to adapt based on actual API docs when available. For now, build flexible structure that can be configured.

## Testing Strategy

1. Unit test `capitalbotService.validateApiKey()` with mock
2. Integration test: create session, select CapitalBot, add key, enable AI
3. End-to-end: send message → verify CapitalBot called → reply sent
4. Test switching providers mid-session