# Operational Runbook — web-pannel

This document is the **single source of truth** for operating
web-pannel at the 500-700 concurrent user target. It covers the
configuration knobs, the v8 per-user credential rotation system, the
period-bounded scrape monitor, and the playbook to dial up capacity
when traffic grows further.

If you make a change in production that is not documented here, add
it. The document is part of the code.

---

## 1. Architecture summary (v8)

Major moving pieces:

| Component                   | Where                                | Purpose                                                                                            |
| --------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Postgres                    | `backend/src/config/database.js`     | Long-lived data (users, sessions, jobs). Sized via `DB_POOL_*` env vars.                           |
| Redis                       | `backend/src/config/redis.js`        | BullMQ queues, rate-limit counters, scrape progress.                                               |
| Express HTTP API            | `backend/src/index.js`               | REST + Socket.IO. Compression on, request log sampled, ws keep-alive tuned.                        |
| GramJS clients              | `backend/src/services/telegramService.js` | One per logged-in Telegram session; bound to a per-user proxy + identity.                  |
| Per-user API credential vault | `backend/src/services/userApiCredentialsService.js` | Multi-credential CRUD + `pickForNewSession()` rotation.                              |
| Scrape monitor              | `backend/src/services/scrapeMonitorService.js` | Period-bounded passive listeners with `monitor:tick` heartbeat.                                |
| Frontend                    | `frontend/src/`                      | React + Vite, lazy-loaded routes, visibility-aware pollers, global `MissingApiCredsModal`.         |

User registration is now **auto-approved**. The only gates left are:

1. **`API_CREDENTIALS_REQUIRED` (HTTP 412)** — user has no usable
   per-user Telegram credential. Surfaced everywhere as a popup.
2. **Subscription / trial** — user has neither an active
   subscription nor a running trial.

Both are enforced server-side in `middleware/auth.js::requireApproved`,
in that order.

---

## 2. Config knobs (env vars)

All knobs are read on boot. Restart the backend after changing them.

### Database pool — `backend/src/config/database.js`

| Var                       | Default | Notes                                                             |
| ------------------------- | ------- | ----------------------------------------------------------------- |
| `DB_POOL_MAX`             | `50`    | Max connections per panel pod. Multiply by pod count for total.   |
| `DB_POOL_IDLE_MS`         | `30000` | Idle reaper.                                                      |
| `DB_POOL_CONNECT_MS`      | `5000`  | Connect timeout.                                                  |
| `DB_POOL_LIFETIME_SEC`    | `600`   | Force-rotate connections so long-lived pods don't accumulate them. |

Postgres `max_connections` should be **at least
`DB_POOL_MAX * panel_pod_count + 20`**. We typically run Postgres at
`max_connections = 200` for two pods (50 each + 100 headroom for
admin tools, BullMQ producers, etc.). At >3 pods, **put pgbouncer in
front of Postgres** (transaction pooling) — sample config in §6.

### HTTP / WS — `backend/src/index.js`

| Var                          | Default   | Notes                                                                 |
| ---------------------------- | --------- | --------------------------------------------------------------------- |
| `WS_PING_INTERVAL_MS`        | `25000`   | Socket.IO ping cadence.                                               |
| `WS_PING_TIMEOUT_MS`         | `20000`   | Time to declare a WS dead.                                            |
| `REQ_LOG_SAMPLE`             | `20`      | Successful GET requests are logged 1-in-N. Always full for writes/4xx/5xx. |
| `SHUTDOWN_GRACE_MS`          | `20000`   | How long graceful shutdown waits for in-flight requests/WS to drain.   |

### Per-user Telegram credentials

| Var                              | Default | Notes                                                                                |
| -------------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `MAX_RUNNING_MONITORS_PER_USER`  | `20`    | Hard cap on simultaneously running monitor jobs per user.                            |

`max_sessions` per credential is set by the user from Settings (1-50).
The rotation logic in `pickForNewSession()` always picks the
credential with the lowest live session count and free capacity.

### Operations / safety

`TELEGRAM_API_ID` and `TELEGRAM_API_HASH` env vars are now **legacy
fallbacks only**. New sessions always pick a per-user credential. The
env vars are still honored when a user passes an explicit override
(e.g. admin tooling), or as the absolute last resort during boot.

---

## 3. Adding capacity (dial-up procedure)

Symptoms of saturation:

- Postgres CPU > 70 % sustained, lots of `FETCH FIRST … ROWS ONLY`
  spinning at the bottom of `pg_stat_activity`.
- WS clients reconnect-spamming (visible as repeated
  `client connected user=...` lines in panel logs).
- HTTP p95 > 1 s on `/api/sessions` and `/api/dashboard/*`.

Apply changes in order; stop as soon as the symptom clears.

1. **Increase `DB_POOL_MAX`** to 80 (re-check Postgres `max_connections`).
2. **Bump `REQ_LOG_SAMPLE`** to 40 if log I/O is dominating.
3. **Add a second panel pod** behind the existing nginx LB. Confirm
   `DB_POOL_MAX * pods + 20 ≤ pg.max_connections`.
4. **Introduce pgbouncer** (transaction pooling) — see §6.
5. **Move BullMQ workers off the panel process** into their own pod
   (`node src/workers.js` → make a dedicated entry point invoking
   `initializeQueues({ workerOnly: true })`).
6. **Shard scrape monitors**: bump `MAX_RUNNING_MONITORS_PER_USER`
   only on a dedicated "monitor pod" with double the DB pool.

Frontend is purely static (Vite build) — scale via CDN.

---

## 4. Per-user credential rotation

How sessions bind to credentials:

```
sessionCreationService.start({ userId, phone })
     │
     ▼
_resolveApi(userId)  ──► userApiCredentials.pickForNewSession(userId)
     │                          │
     │                          ▼
     │           SELECT … FROM user_api_credentials WHERE
     │             user_id=$1 AND is_active=TRUE AND deleted_at IS NULL
     │           ORDER BY  live_session_count ASC, id ASC
     │           LIMIT 1
     │
     ▼
  apiId / apiHash / credentialId
     │
     ▼
INSERT INTO sessions (..., user_api_credential_id) VALUES (..., $N)
```

Key invariants:

- Rotation is **per-user**, not global. We never share a credential
  across users.
- `max_sessions` is enforced at the SQL level by the `live_session_count`
  comparison, so there's no race between two concurrent inserts.
- A session always remembers its `user_api_credential_id`. On
  reconnect, `telegramService._loadSessionFromDB()` prefers the live
  vault row over the per-session snapshot — so rotating an api_hash in
  Settings transparently picks up on the next reconnect.

If a user deletes their last credential, every panel feature returns
`HTTP 412 API_CREDENTIALS_REQUIRED` until they add another one.

---

## 5. Period-bounded scrape monitor

Use case: target chat's participant list is admin-only. Instead of
failing the scrape, the user toggles **"Are this group/channel's
members hidden?"** in the Scrape page, picks a duration, and we
attach passive `NewMessage` listeners to every selected session.

Highlights:

- Per-user concurrency cap: `MAX_RUNNING_MONITORS_PER_USER` (default 20).
  Returns 429 `TOO_MANY_RUNNING_MONITORS` with a friendly message.
- Heartbeat: every 10 s the backend emits `monitor:tick` on the
  user's Socket.IO room with `{ jobId, scrapedCount, remainingSeconds,
  ratePerMinute }`. The Scrape page UI updates live.
- Crash-safe: on boot, `resumeActiveJobs()` re-attaches listeners for
  every job that was running and not yet expired; the rest roll to
  `completed`.
- Pause / resume: pause detaches listeners and persists
  `remaining_seconds`; resume reattaches and recomputes `expires_at`.

---

## 6. Sample pgbouncer config (transaction pooling)

Use when running 3+ panel pods or BullMQ worker pods. Drop in as
`/etc/pgbouncer/pgbouncer.ini` and point the panel at port 6435
instead of 5435 (these are the +3-shifted defaults; see §11).

```ini
[databases]
telegram_panel = host=127.0.0.1 port=5435 dbname=telegram_panel

[pgbouncer]
listen_addr = 127.0.0.1
listen_port = 6435
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
default_pool_size = 50
max_client_conn = 2000
reserve_pool_size = 20
reserve_pool_timeout = 5
server_idle_timeout = 600
server_lifetime = 3600
log_connections = 0
log_disconnections = 0
ignore_startup_parameters = extra_float_digits
```

Caveats:

- `pool_mode = transaction` breaks `LISTEN/NOTIFY` and prepared
  statements. Our codebase doesn't use either.
- The panel issues every multi-statement transaction inside a
  `pool.connect()` block, so transaction pooling is safe.

---

## 7. Database migrations

All migrations live in `backend/src/config/` and are registered in
`backend/src/config/database.js::migrations[]`. They run on boot
inside a single transaction per migration. To add one:

1. Create `migration_v<N>_<short_name>.sql`.
2. Append `{ name, file }` to the `migrations` array in
   `database.js`.
3. Restart the backend. The migrator skips files that have already
   been applied.

Do NOT edit migrations after they ship. If a migration is wrong, add
a new one that fixes it.

---

## 8. Auth changes in v8

- Registration always returns `status='approved'`,
  `is_approved=TRUE`, `approved_at=NOW()`.
- The `/pending` route still exists for legacy users an admin
  manually rolled back to pending and for banned users.
- New users land on `/billing` after Register so they can either
  start the trial or pay immediately.
- `apiCredentialsCount` is now part of every `/auth/*` response and
  drives the global popup.

---

## 9. Quick health checks

```bash
# Backend health
curl -s http://localhost:3005/health

# Postgres connection saturation
psql -c "SELECT count(*) FROM pg_stat_activity WHERE datname='telegram_panel';"

# Redis health
redis-cli -p 6392 -a "$REDIS_PASSWORD" PING

# Active monitor jobs
psql -c "SELECT user_id, COUNT(*) FROM scrape_monitor_jobs WHERE status='running' GROUP BY user_id ORDER BY 2 DESC LIMIT 10;"

# Active sessions per credential
psql -c "SELECT user_api_credential_id, COUNT(*) FROM sessions WHERE status='active' GROUP BY 1 ORDER BY 2 DESC LIMIT 10;"
```

---

## 10. Multi-platform (Telegram + Instagram) — v9+

The panel now runs **two providers** behind the same web UI: Telegram
(`telegram-private-api` / GramJS) and Instagram (`instagram-private-api`).
Both providers expose the same shape (sessions, scrape, messaging,
threads, lists, reports, …) but route to platform-specific
implementations. This section covers everything you need to operate
the Instagram side at the 500-700 user target.

### 10.1 Feature flag

Frontend visibility of the Instagram panel is gated by a per-browser
flag for the staged rollout:

```js
// In the browser dev console (or set programmatically in Settings)
localStorage.setItem('feature_instagram_panel', '1');
```

Backend always serves Instagram routes; the flag only hides the UI
toggle. Once general availability is reached, remove the flag and the
toggle becomes unconditional.

### 10.2 Per-platform queue knobs

Two new BullMQ queues run alongside the Telegram queues:

| Queue                | Default concurrency       | Env var                          |
| -------------------- | ------------------------- | -------------------------------- |
| `scrape:instagram`   | 3                         | `IG_SCRAPE_CONCURRENCY`          |
| `messaging:instagram`| 2                         | `IG_MESSAGING_CONCURRENCY`       |

Set `IG_QUEUES_ENABLED=false` to disable IG queue initialization on
emergency rollback (frontend will degrade gracefully — IG endpoints
return 503 from the queue dispatcher).

The default Instagram concurrency is **lower** than Telegram (3/2 vs
TG 5/x) because Instagram's account-level rate limits are stricter
and a single IG account that bursts past ~30 actions per 15 minutes
gets challenged within hours.

### 10.3 Per-platform proxies

Both providers consume the same `proxies` table but each has its own
**validator**:

- Telegram (`backend/src/providers/telegram/proxies.js::validate`) —
  opens a TG-style transport handshake to `149.154.167.50:443`.
- Instagram (`backend/src/providers/instagram/proxies.js::validate`) —
  performs a TLS handshake to `i.instagram.com:443` and pulls
  `/api/v1/users/checkpoint/` as a sanity check.

A proxy can be marked as TG-only, IG-only, or both via the
`platforms` JSONB column on `proxies` (default = both).

### 10.4 Per-platform billing

Three pricing rails:

```
billing.telegram.subscription_price_usd   (defaults: 9.99 / 30 days)
billing.instagram.subscription_price_usd  (defaults: 9.99 / 30 days)
billing.bundle.subscription_price_usd     (defaults: 14.99 / 30 days)
```

The bundle invoice unlocks both platforms in a single payment.
Trials are **per-platform** — using the trial on Telegram doesn't
consume the Instagram trial credit.

### 10.5 Per-platform Socket.IO rooms

Each browser tab joins:

- `user:<userId>` (always — cross-platform notifications)
- `platform:<userId>:<telegram|instagram>` (active panel only)

When the user toggles platforms in the header, the client emits
`platform:unsubscribe` then `platform:subscribe` so live counters
flip cleanly.

### 10.6 Capacity dial-up procedure (IG-specific)

In addition to the Telegram capacity steps in §3:

1. **IG sessions are heavier** than TG (full HTTPS round-trip per
   action vs TG's persistent MTProto socket). At >300 concurrent IG
   users, double `IG_SCRAPE_CONCURRENCY` and watch IG account ban
   rates closely. If bans tick up, halve it.
2. **IG warmup queue** runs at `IG_WARMUP_CONCURRENCY` (default 1) —
   keep it serial; warmup races trigger checkpoints.
3. **IG client pool memory**: each logged-in IG client holds ~3-4 MB
   for cookies, device state, and feed cache. At 500 concurrent IG
   sessions per pod, expect ~1.5-2 GB resident set just for IG.
   Plan accordingly when sizing pods.

### 10.7 Quick health checks (IG)

```bash
# IG sessions per status
psql -c "SELECT status, COUNT(*) FROM sessions WHERE platform='instagram' GROUP BY 1;"

# IG scrape queue depth
redis-cli -p 6392 -a "$REDIS_PASSWORD" LLEN bull:scrape:instagram:waiting

# IG messaging queue depth
redis-cli -p 6392 -a "$REDIS_PASSWORD" LLEN bull:messaging:instagram:waiting

# IG accounts that hit checkpoint (login / 2FA / device confirmation)
psql -c "SELECT id, username, last_error FROM sessions WHERE platform='instagram' AND status='checkpointed' ORDER BY updated_at DESC LIMIT 20;"
```

---

## 11. Shifting all service ports

The stack ships with every port shifted by **+3** from the canonical
defaults so it can coexist with a stock Postgres/Redis/Vite install on
the same host. The current set is:

| Service                 | Original | Current (+3) | Notes                                   |
| ----------------------- | -------- | ------------ | --------------------------------------- |
| Backend HTTP/WebSocket  | `3000`   | `3005`       | Express + Socket.IO. Bumped from `3003` to coexist with another host service. |
| Postgres (in-container) | `5432`   | `5435`       | overridden via `command: postgres -p`   |
| Postgres (host-mapped)  | `5436`   | `5439`       | docker-compose `ports:` left side       |
| Redis (in-container)    | `6379`   | `6382`       | overridden via `redis-server --port`    |
| Redis (host-mapped)     | `6389`   | `6392`       | docker-compose `ports:` left side       |
| Vite dev server         | `5173`   | `5176`       | `frontend/vite.config.js`               |
| Frontend nginx (in-c.)  | `80`     | `83`         | `frontend/nginx.conf` + `Dockerfile`    |
| Frontend nginx (host)   | `8080`   | `8083`       | docker-compose `ports:` left side       |
| pgbouncer (optional)    | `6432`   | `6435`       | §6 sample config                        |

### 11.1 To shift everything by another delta `D`

Replace `D` with the desired offset (e.g. `+3`, `-3`, `+10`):

1. **`docker-compose.yml`**
   - `postgres.command`: `postgres -p <5432+D>`
   - `postgres.environment.PGPORT`: `<5432+D>`
   - `postgres.ports`: `"<host+D>:<5432+D>"`
   - `postgres.healthcheck`: `pg_isready -U postgres -p <5432+D>`
   - `redis.command`: `redis-server --port <6379+D> --requirepass …`
   - `redis.ports`: `"<host+D>:<6379+D>"`
   - `redis.healthcheck`: add `-p <6379+D>`
   - `backend.ports`: `"<3000+D>:<3000+D>"`
   - `backend.environment`: `DB_PORT=<5432+D>`, `REDIS_PORT=<6379+D>`,
     `PORT=<3000+D>`
   - `frontend.ports`: `"<8080+D>:<80+D>"`
2. **`backend/.env.example`** — bump `PORT`, `DB_PORT`, `REDIS_PORT`.
3. **`backend/Dockerfile`** — `EXPOSE <3000+D>`.
4. **`backend/src/index.js`** — three literals to update:
   - `cors.origin` default (Socket.IO block)
   - `cors()` middleware default
   - `const PORT = process.env.PORT || <3000+D>`
5. **`backend/src/config/database.js`** — `DB_PORT` fallback.
6. **`backend/src/config/redis.js`** — `REDIS_PORT` fallback.
7. **`backend/src/queues/{scrapeQueue,twoFAQueue,instagramScrapeQueue,instagramMessageQueue}.js`**
   — each has its own `REDIS_PORT` fallback. (`messageQueue.js` and
   `groupQueue.js` reuse `config/redis.js`, so they pick it up
   automatically.)
8. **`frontend/vite.config.js`** — `server.port`, `proxy['/api'].target`,
   `proxy['/socket.io'].target`.
9. **`frontend/nginx.conf`** — `listen` directive + two `proxy_pass`
   lines.
10. **`frontend/Dockerfile`** — same three lines inside the inline
    nginx config + the final `EXPOSE`.
11. **`OPS.md`** — update §6 (pgbouncer), §9 (health checks),
    §10.7 (IG health checks), and this §11 table itself.

### 11.2 Verification

```bash
# Backend syntax
cd backend && find src -name '*.js' -exec node --check {} \;

# Frontend build
cd frontend && npm run build

# Confirm no stale references to the old ports remain (replace 5432
# etc. with whatever you just shifted away from):
rg -n '\\b(3000|5432|6379|5173|6389|5436|8080)\\b' \
   docker-compose.yml backend/.env.example backend/src frontend
```

### 11.3 Anything that does NOT need to change

These all look like ports but are **not**:

- Timeout / delay values: `LOGIN_TIMEOUT_MS = 30000`,
  `DEFAULT_DELAY_MAX = 3000`, `pingInterval = 25000`, `pingTimeout =
  20000`, `usePolling(fn, 30000, …)`, `Toast.duration = 3000`, etc.
- Connection-string or capacity numbers in
  `INSTAGRAM_PANEL_ARCHITECTURE.md` (e.g. "3000 active sessions").
- Telegram / Instagram remote API ports (always `443`).

When grepping for ports, prefer matching the variable / config key
(`PORT=`, `REDIS_PORT`, `DB_PORT`, `proxy_pass http://`, `listen `,
`server.port`) over matching the bare number, so you don't get fooled
by timeouts that happen to look like port numbers.

