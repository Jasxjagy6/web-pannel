# Scaling to 1000+ Telegram sessions on one panel

This document explains the architecture additions that prepare the
panel for fleets in the 1000-session range, and — equally important —
the **rules** that keep currently-active sessions from being lost
during upgrades.

> The user's hard rule for this work:
>
> > "If I lost them from pannel I will completely lost them."
>
> A `StringSession` cannot be re-issued by Telegram. Once the
> `auth_key` bytes are gone, the session is permanently dead and the
> human has to re-upload the account. Every change in this document
> is built around protecting those bytes.

---

## Components

The 1000-session foundation is **all-additive**. Today's panel keeps
running unchanged unless you opt into the new behaviour via env vars.

| Component | File | Default | Purpose |
| --- | --- | --- | --- |
| Session ownership lock | `backend/src/services/sessionOwnershipLock.js` | OFF (`STRICT_SESSION_LOCK=false`) | Redis-backed mutex over each session's `auth_key`, with fencing tokens. Prevents two processes from simultaneously connecting the same session. |
| Session affinity | `backend/src/workers/sessionAffinity.js` | OFF (utility module) | Consistent-hash mapping `sessionId → workerId` so session-to-worker pinning is stable when workers are added or removed. |
| Session health cache | `backend/src/services/sessionHealthCache.js` | Always available | Memoizes `getMe()` results for 30s (positive) / 5min (permanent error). Removes the per-request `getMe` cost as session count grows. |
| Sharded worker process | `backend/src/workers/sessionWorker.js` | OFF (`SESSION_WORKER_MODE=worker`) | Separate Node process that runs only the BullMQ workers (no HTTP server). Lets the API process stay snappy while heavy Telegram RPCs run elsewhere. |
| Migration safety lint | `backend/scripts/check-migration-safety.js` | Run manually | Refuses any SQL migration that would `DROP` / `RENAME` / `TRUNCATE` / `DELETE` from `sessions` or `session_backups`. |
| Pre/post-deploy verifier | `backend/scripts/verify-sessions.js` | OFF (`SESSION_SAFETY_VERIFY=true`) | Snapshots every active session's encrypted bytes before a deploy and confirms post-deploy that every session that was readable before is still readable. Triggers a hard fail on regression. |

---

## How the lock keeps sessions alive

When `STRICT_SESSION_LOCK=true`:

1. `telegramService._ensureConnected(sessionId)` calls
   `sessionOwnershipLock.acquire(sessionId, holderId)` before reusing
   or opening any MTProto client.
2. Acquire is a Redis `SET tgsessionlock:{id} <fencingToken> NX PX
   60000`. If the key already exists with a different holder's
   prefix, acquire returns `null` and `_ensureConnected` throws
   `SESSION_LOCKED_BY_OTHER_WORKER` with HTTP 409.
3. While the lock is held, a heartbeat (every 20s) refreshes the
   TTL. The refresh is a CAS Lua script — only refreshes if our
   token is still on the key. If it isn't, the heartbeat
   disconnects the local MTProto client (so we don't keep
   talking to Telegram on bytes that another worker now owns).
4. On `disconnectSession()` and on graceful drain (SIGTERM), every
   held lock is released CAS-style.

If Redis is unreachable, `acquire()` returns a sentinel "noop token"
and the lock becomes a no-op. The panel keeps running on its
in-process `clients` Map exactly like today. This **fail-open**
posture matches `utils/jobLock.js` — making the panel unavailable
during a Redis blip is worse than the small race window we're
guarding against in single-process mode.

---

## Recommended rollout

Roll the foundation out gradually so each piece is observed in
production before turning on the next.

### Step 1 — Land the foundation (no behaviour change)

Merge this PR. With no env changes, **the panel behaves identically
to before.** All new modules are loaded but disabled. New scripts are
available but unused.

### Step 2 — Add the migration safety lint to CI

```bash
# Add to your CI pipeline (or .git/hooks/pre-commit):
node backend/scripts/check-migration-safety.js
```

Now any future migration that tries to DROP / RENAME / TRUNCATE the
`sessions` or `session_backups` tables fails the build before it
reaches main.

### Step 3 — Turn on session safety verification (still no
behaviour change to the panel itself)

```bash
SESSION_SAFETY_VERIFY=true bin/upgrade deploy
```

Every deploy from now on:
- snapshots every active session's encrypted bytes pre-deploy,
- re-verifies post-deploy,
- aborts (exit 2) if any session that was readable became
  unreadable.

This is the strongest defence against accidentally losing sessions
to a bad migration. It is read-only and never modifies anything in
the panel's runtime state.

### Step 4 — Turn on the session ownership lock in the API process

```bash
# .env on the API box
STRICT_SESSION_LOCK=true
```

The API process now grabs Redis locks before connecting MTProto.
With only one process, there's never any contention — but the lock
machinery is exercised in production traffic and you can verify in
`redis-cli KEYS tgsessionlock:*` that locks come and go cleanly with
session connects / disconnects.

### Step 5 — Add the first sharded worker process

Run this **alongside** the existing API server:

```bash
# /etc/systemd/system/web-pannel-worker-0.service or compose service
SESSION_WORKER_MODE=worker SHARD_ID=0 SHARD_COUNT=1 STRICT_SESSION_LOCK=true \
    node backend/src/workers/sessionWorker.js
```

The worker process loads BullMQ consumers but no HTTP server. It
takes session locks on demand. The API process still functions
normally — for any session a worker isn't actively running an RPC
against, the API can take the lock just like today.

> **Important:** until job-routing affinity lands (next PR), only run
> **one** worker process. Multiple BullMQ workers without
> session-aware routing would race for jobs and the lock would
> reject duplicate connects, causing those jobs to retry. One
> worker = no contention, full lock semantics, isolated event loop.

### Step 6 — (Future PR) Turn on per-shard job routing

When the next PR lands you'll be able to run N>1 worker processes
with deterministic job routing. Each worker only pulls jobs for
sessions it owns; the lock is the safety net.

---

## Migration policy

**The `sessions` and `session_backups` tables are append-only from
the panel's perspective.** Migrations may add columns, indexes, or
new tables. They MAY NOT:

- DROP / RENAME / ALTER TYPE on any column in those tables
- DROP, TRUNCATE, or DELETE FROM those tables
- UPDATE the protected columns: `session_file_path`, `api_id`,
  `api_hash`, `phone`, `account_info`, `session_string`,
  `session_data`, `backup_path`, `content_sha256`

If you genuinely need one of these operations, do it via a runtime
ops endpoint with audit logging — NOT via a migration that runs
unattended on every deploy.

`backend/scripts/check-migration-safety.js` enforces this in CI.

---

## Recovering a lost session

If a session was readable yesterday but isn't now, in this order:

1. **Check `session_backups`.** Anti-revoke Phase 4 already
   snapshots every session on creation, login, and weekly. The
   bytes are encrypted with the same key as `session_file_path`.
   ```sql
   SELECT id, content_sha256, backup_path, reason, retain_until
     FROM session_backups
    WHERE session_id = $1
    ORDER BY id DESC;
   ```
2. **Restore the file.** Copy the `backup_path` content over the
   missing `session_file_path`. The next `_ensureConnected` will
   pick it up.
3. **If the auth_key was actually invalidated by Telegram** (e.g.
   the human terminated the session from another device), the row
   is `status='revoked'` — re-upload is the only fix. The backup
   bytes won't help; Telegram has already rejected them.
4. **If you have neither a working file nor a backup row,** the
   session is gone. The session-safety verifier exists precisely
   to catch this BEFORE a deploy can do it silently.

---

## Operator runbook: zero-downtime upgrade with session safety on

```bash
SESSION_SAFETY_VERIFY=true \
SESSION_SAFETY_BASELINE_DIR=/var/lib/web-pannel \
bin/upgrade deploy --ref main
```

What `bin/upgrade` does:

```
 1. fetch + checkout target ref
 2. build / pull image
 2b. session-safety baseline → /var/lib/web-pannel/session-baseline-<sha>.json
 3. apply migrations (refused if any violate sessions safety policy)
 4. start new backend color
 5. wait for /health/ready
 6. build + start new frontend color
 7. flip Caddy
 8. drain old color
 9. stop old color
 9b. session-safety post-check vs the baseline → exit 2 on any
     regression (operator runs `bin/upgrade rollback`)
10. persist active state
```

If step 9b detects a regression, the new color is already live and
serving traffic — but Caddy still has both colors known to it. The
rollback path flips Caddy back to the previous color and stops the
new one, restoring the panel to exactly the state it was in before
the deploy. Sessions are safe because the migration policy (step 3)
already refused the destructive change before the bytes were
touched.

---

## Why we chose Redis SETNX with fencing tokens

The shape of this lock is conventional but worth justifying because
the cost of a mistake is permanent session loss:

- **Redis** because it's already the panel's coordinator (BullMQ,
  jobLock, OTP relays). No new dependency.
- **SETNX with PX TTL** so a worker that hard-crashes can't hold
  the lock forever — TTL expires and the next worker takes over
  within 60s.
- **Fencing tokens** so a stale holder can't accidentally release
  a newer holder's lock. The `EVAL`'d CAS script (`if GET ==
  ARGV[1] then DEL/PEXPIRE`) is atomic with respect to a third
  worker concurrently acquiring.
- **Heartbeat refresh** so long-running operations don't lose the
  lock mid-RPC. The heartbeat itself is the lock-loss detector —
  if it returns `0` we know we've been preempted.
- **Fail-open** because in a Redis outage, blocking session
  connections is worse than the (already-tolerated) single-process
  in-memory contention model.

The same pattern is already proven by `utils/jobLock.js` for the
serial bulk-DM path; this is a per-session generalization.
