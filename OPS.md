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
`/etc/pgbouncer/pgbouncer.ini` and point the panel at port 6432
instead of 5432.

```ini
[databases]
telegram_panel = host=127.0.0.1 port=5432 dbname=telegram_panel

[pgbouncer]
listen_addr = 127.0.0.1
listen_port = 6432
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
curl -s http://localhost:3000/health

# Postgres connection saturation
psql -c "SELECT count(*) FROM pg_stat_activity WHERE datname='telegram_panel';"

# Redis health
redis-cli -p 6389 -a "$REDIS_PASSWORD" PING

# Active monitor jobs
psql -c "SELECT user_id, COUNT(*) FROM scrape_monitor_jobs WHERE status='running' GROUP BY user_id ORDER BY 2 DESC LIMIT 10;"

# Active sessions per credential
psql -c "SELECT user_api_credential_id, COUNT(*) FROM sessions WHERE status='active' GROUP BY 1 ORDER BY 2 DESC LIMIT 10;"
```
