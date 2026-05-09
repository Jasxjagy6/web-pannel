---
name: testing-telegram-add-members
description: End-to-end test the Telegram add-members flow with user-provided session JSONs and a CSV list. Use when verifying the access_hash precision fix, the runtime backfill, real-time progress events, or any change to addMembersToGroups / telegramService._resolveEntity. Also useful any time the user reports the panel can't add users by ID.
---

# Testing the Telegram add-members flow

Use this when the user provides session JSONs and a list (CSV) and asks Devin to verify users actually get added to a Telegram group.

## Devin Secrets Needed

- **`TELEGRAM_API_ID` / `TELEGRAM_API_HASH`** — required for the panel to dial Telegram. The user usually supplies these inline in the request; they get persisted into `backend/.env` and into a `user_credentials` row via `POST /api/user-credentials`.
- No other secrets are needed; sessions come in as JSON attachments from the user.

## Local environment (one-shot setup)

```
cd backend && cp .env.example .env  # then edit ports + passwords
#   IMPORTANT: passwords with `#` characters MUST be quoted in .env, e.g.
#     DB_PASSWORD="foo###@"   REDIS_PASSWORD="bar###"
#   Otherwise dotenv parses everything after `#` as a comment and auth fails.
docker compose up -d postgres redis
npm i && npm run dev      # boots on :3005, runs migrations
cd ../frontend && npm i && npm run dev    # vite on :5176, proxies /api to :3005
```

Default admin user is auto-seeded (see `users` table). Login with `admin@example.com` / `admin123` to get a JWT for API calls.

## Repro flow

1. **Login** → `POST /api/auth/login` with the admin creds; save the `token`.
2. **Set Telegram API creds** → `POST /api/user-credentials` with `{label, apiId, apiHash, maxSessions}`. Without this, session uploads fail with `API_CREDENTIALS_REQUIRED`.
3. **Upload sessions** → `POST /api/telegram/sessions/upload?autoLogin=true` (multipart, field name `sessions`, multiple files OK). The route accepts the `{ session, ... }` JSON shape used by SessionsAPI exports.
4. **Smoke-test sessions are alive** → `POST /api/telegram/scrape/preview` with `{sessionIds, targets}`. If a session can't reach a target it returns `canScrape:false, reason:"entity_not_found"`. If it CAN reach the target, that's strong evidence the session is connecting to Telegram (not just stored as `isLoggedIn=true`).
5. **Scrape the target group** → `POST /api/telegram/scrape/group` with `{sessionIds, targetIds}`. Wait until the job is complete (poll `/api/telegram/scrape/jobs/:id`). This populates `scraped_users` with real int64 access_hashes.
6. **Build a list from the scrape** *(optional, for T10-style regression)* → `POST /api/telegram/lists/from-scrape` with `{scrapeJobId, listName}`. Verify each row's `access_hash` matches `scraped_users.access_hash` byte-for-byte.
7. **Import the user's CSV** → `POST /api/telegram/lists/import` (multipart, `file` + `name` + `type=users`).
8. **Trigger add-members** → `POST /api/telegram/groups/add-members` with `{sessionIds, targetIds, targetType:"group", userList, async:true, mode:"auto"}`. The userList items must use **camelCase** keys (`telegramId`, `firstName`, `accessHash`, `phone`). Snake-case keys silently get dropped by the audience filter and you'll see weird `duplicatesRemoved` counts.
9. **Watch progress** → `GET /api/telegram/groups/operations/:id` returns `redisProgress` (live counters) and `results[]` (per-row outcomes).

## What "good" looks like

- `scraped_users.access_hash` rows are 18–20 digits long (real int64s). 17-or-fewer digits with the same prefix are precision-truncated remnants of the bug — re-scrape to overwrite.
- `addMembersToGroups: backfilled N access_hash values from scraped_users` appears in the backend log at job start whenever the userList contains numeric IDs without hashes that overlap with `scraped_users`.
- Per-row failures attribute real Telegram error codes: `USER_PRIVACY_RESTRICT`, `USER_NOT_MUTUAL_CONTACT`, `USERNAME_NOT_OCCUPIED`, `USER_ID_INVALID`, `PEER_FLOOD`, `BOTS_TOO_MUCH`, etc.
- **`grep -c 'Could not find the input entity' backend.log` is `0`.** Non-zero means the access_hash precision regressed somewhere.

## Telltale errors that are NOT panel bugs

- `AUTH_KEY_DUPLICATED` (caused by `users.GetUsers` / `contacts.ResolveUsername`) — the same session JSON is logged in elsewhere. Telegram revokes one of the connections. Workaround: re-export fresh sessions for the test environment.
- `PEER_FLOOD` — Telegram-side per-session rate limit. The panel auto-cools the session for hours via `sessions.cooldown_until`. For a quick re-test, you may temporarily clear the cooldown row in the DB; do NOT change the cooldown logic.
- `entity_not_found` from `/scrape/preview` — the session simply isn't a member of that group. Tell the user to add the session to the group first.
- `No session is a member of this target` — same root cause as above; the panel guards this correctly.

## DB-level invariants worth checking after any change to the resolve path

```sql
-- 1. Distribution of access_hash digit lengths in scraped_users.
SELECT length(access_hash::text) AS digits, count(*)
FROM   scraped_users
WHERE  access_hash IS NOT NULL
GROUP  BY 1 ORDER BY 1;
--    Should peak around 18–20 digits. A peak at 17 is the precision bug.

-- 2. list_items.access_hash matches scraped_users.access_hash for the same telegram_id.
SELECT li.telegram_id, li.access_hash, su.access_hash
FROM   list_items li
JOIN   scraped_users su USING (telegram_id)
WHERE  li.access_hash IS NOT NULL
  AND  li.access_hash <> su.access_hash;
--    Must return zero rows.
```

## Standalone unit-style precision proof

If you're not sure whether `bigintToString` is being bypassed somewhere, run:

```
node -e '
const raw = 5612089012345678901n;
console.log("raw                    :", raw.toString());
console.log("via Number(bigint) (bug):", String(BigInt(Number(raw))));
console.log("matches raw            :", String(BigInt(Number(raw))) === "5612089012345678901");'
```

The bug path produces `5612089012345678848`. If your fix preserves precision, the rest of the pipeline must use `bigintToString` or equivalent string/BigInt path — never `Number()` — when handling `access_hash`.

## Out of scope

- Instagram session paths (`telegramService` is Telegram-only).
- The `change-2fa` flow (separate queue).
