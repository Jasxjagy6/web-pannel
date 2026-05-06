# Dynamic Zero-Downtime Upgrade Runbook

This is the operator-facing reference for upgrading `web-pannel` in
production without dropping HTTP, Socket.IO, or live MTProto/GramJS
sessions, and without touching durable data (Postgres, Redis, uploaded
sessions).

If you are looking for the *design* of the upgrade system, see
the PR description and `docs/MIGRATIONS.md`.

---

## TL;DR — happy path

After merging a PR to `main`:

```bash
ssh vps
cd /opt/web-pannel
git pull --ff-only origin main          # only needed if local mode is used
./bin/upgrade deploy --ref main         # ← the one command that matters
```

Or from Telegram (any whitelisted admin):

```
/upgrade main PIN=hunter2
```

That's it. ~30 seconds end-to-end on a warm host. No downtime. State preserved.

---

## 1. Architecture (very brief)

```
internet
    │
    ▼
 Caddy            public-facing reverse proxy + admin API on :2019
   │   │
   │   └── /            → frontend-blue OR frontend-green  (static SPA)
   │
   └────── /api/*       → backend-blue  OR backend-green
           /socket.io/*

 postgres :5435   named volume postgres_data
 redis    :6382   named volume redis_data
 uploads          named volume uploads_data
 sessions         named volume sessions_data
 logs             named volume logs_data
 state            named volume state_data
```

Two backend containers AND two frontend containers exist, but only one
of each (`blue` or `green`) serves traffic at any moment. The
orchestrator starts the inactive color with the new image (backend
first, then frontend), waits for `/health/ready` on the backend and a
"/" 200 on the frontend, atomically tells Caddy to switch BOTH
upstreams in a single admin POST, drains the old colors, and stops
them.

Postgres, Redis, and the persistent volumes are **never** restarted
during a normal deploy. Backend AND frontend always flip in lockstep
(same color) so there is never a code-skew between SPA bundle and API
shape.

---

## 2. First-time setup on the VPS

### 2.1 Clone and prepare the host

```bash
sudo mkdir -p /opt/web-pannel
sudo chown $USER:$USER /opt/web-pannel
git clone https://github.com/Jasxjagy6/web-pannel.git /opt/web-pannel
cd /opt/web-pannel

cp .env.example .env                # then edit values
cp backend/.env.example backend/.env
```

Edit `.env`:

- `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `JWT_SECRET` — production secrets.
- `PUBLIC_DOMAIN` — set if you want auto-TLS via Let's Encrypt.
- `UPGRADE_REGISTRY=ghcr.io/<owner>/web-pannel-backend` — set if you want
  the orchestrator to pull pre-built images instead of building locally.
- `TELEGRAM_ADMIN_BOT_TOKEN`, `TELEGRAM_ADMIN_IDS`,
  `UPGRADE_CONFIRM_PIN` — leave empty if you don't want the bot.

### 2.2 First boot

```bash
docker compose --profile blue --profile bot up -d
```

This starts: postgres, redis, caddy, backend-blue, frontend-blue,
admin-bot (only if the bot env vars are set). The `blue` profile
brings up BOTH the backend and the frontend in the blue color. The
orchestrator handles the green side on subsequent deploys.

> **Migrating from the pre-blue/green frontend topology.** Older
> compose files spawned a single `frontend` service. The first
> `bin/upgrade deploy` after pulling this revision will detect that
> legacy container, force-remove it, then bring up `frontend-blue` /
> `frontend-green` in lockstep with the backend. No manual cleanup is
> required.

Verify:

```bash
./bin/upgrade status
./bin/upgrade health
curl -s http://localhost/api/healthcheck   # via Caddy → backend
```

After the first boot, `state/active-color.json` will be created on the
first successful `bin/upgrade deploy`.

---

## 3. Deploying a new version

### 3.1 Local-build mode (default — no registry needed)

```bash
./bin/upgrade deploy --ref main
```

What it does:

1. Acquires `state/upgrade.lock` (refuses to run if another deploy is in
   flight).
2. Runs `scripts/backup-now.sh` (postgres dump, redis RDB, uploads tar,
   sessions tar) into `./backups/<timestamp>/`. Aborts on failure unless
   `BACKUP_REQUIRED=false`.
3. `git fetch && git checkout <sha>`.
4. `docker compose build` → tagged `web-pannel-backend:<short-sha>`.
5. Runs `node bin/migrate.js --apply` inside a one-shot container of the
   new image. Each migration runs in its own transaction.
6. Starts the inactive backend color (`backend-green` if blue is active).
7. Polls `/health/ready` on the new backend color (DB+Redis pingable,
   queues initialized, sessions restore loop done) up to
   `ROLLOUT_HEALTH_TIMEOUT_MS` (default 120s).
8. Removes the legacy single-`frontend` container if one exists (one-time
   migration), then `docker compose build frontend-blue` to produce a
   fresh `web-pannel-frontend:<short-sha>` image.
9. Starts the inactive frontend color (`frontend-green` if blue is
   active) and polls "/" until nginx returns 200, up to
   `FRONTEND_HEALTH_TIMEOUT_MS` (default 60s).
10. POSTs a fresh Caddy config to `127.0.0.1:2019/load`. Cutover happens
    atomically — new requests go to BOTH the new backend and new
    frontend colors; in-flight requests finish on the old upstreams.
11. Sleeps `DRAIN_GRACE_MS` (default 25s) so live Socket.IO clients
    reconnect to the new backend color and the previous SPA tab finishes
    any pending fetch().
12. Stops the old backend AND old frontend containers.
13. Updates `state/active-color.json` (with both colors) and inserts a
    row in the `deployments` table.

### 3.2 Registry mode (CI-built images)

After the GitHub Actions workflow `build-backend.yml` publishes images
to GHCR:

```bash
./bin/upgrade deploy --ref main --build registry
# Equivalent to: docker pull ghcr.io/<owner>/web-pannel-backend:<sha>
```

Set `UPGRADE_REGISTRY=ghcr.io/<owner>/web-pannel-backend` in `.env` to
make registry mode the default.

### 3.3 Rolling back

```bash
./bin/upgrade rollback
```

Reads `state/active-color.json::previous.git_sha` and re-runs the deploy
flow against that SHA. Same time-to-recover as a forward deploy
(~30 seconds on a warm host since the image is already on disk).

### 3.4 Anatomy of a deploy log

```
[03:18:12] git fetch origin (ref=main)
[03:18:13] resolved main → ab12cd34ef56
[03:18:13] building web-pannel-backend:ab12cd34ef56 …
[03:18:42] running migrations (mode=apply)
[03:18:42]   migrate: up to date.
[03:18:42] starting backend-green
[03:18:46]   /health/ready ok in 4188ms
[03:18:46] pushing Caddy config → backend-green:3005
[03:18:46] draining backend-blue for 25000ms
[03:19:11] stopping backend-blue
[03:19:12] deploy OK in 60100ms — active color is now green (ab12cd34ef56)
```

---

## 4. Telegram admin bot

When `TELEGRAM_ADMIN_BOT_TOKEN` and `TELEGRAM_ADMIN_IDS` are set, the
`admin-bot` Compose service runs a long-poll bot. It only responds to
the whitelisted admin chat IDs.

Commands:

| Command                | Description                                     |
| ---------------------- | ----------------------------------------------- |
| `/help`                | command list                                    |
| `/status`              | active color + last 10 deploys                  |
| `/health`              | probe blue and green                            |
| `/upgrade <ref>`       | deploy a branch / tag / sha                     |
| `/rollback`            | redeploy the previous SHA                       |
| `/migrate check\|apply`| run the migration CLI                           |
| `/logs [N]`            | tail N lines of backend logs                    |

If `UPGRADE_CONFIRM_PIN` is set, destructive commands (`/upgrade`,
`/rollback`, `/migrate apply`) require the user to append
`PIN=<value>` to their message:

```
/upgrade main PIN=hunter2
```

The bot streams progress back to chat by editing a single message — you
see the full deploy log appear line-by-line.

### 4.1 Why long-polling

No webhook means no inbound port, no public URL, no NAT rules. The bot
runs entirely outbound from the VPS to `api.telegram.org`. Works behind
any firewall.

### 4.2 Disabling the bot

Either remove the token from `.env`, or stop the service:

```bash
docker compose stop admin-bot
docker compose rm -f admin-bot
```

---

## 5. Health endpoints

| Endpoint            | Status code | What it checks                                                                                |
| ------------------- | ----------- | --------------------------------------------------------------------------------------------- |
| `/health`           | always 200  | process alive (used by Docker HEALTHCHECK and Caddy active-health probe)                      |
| `/health/live`      | always 200  | k8s alias                                                                                     |
| `/health/ready`     | 200 / 503   | DB pingable + Redis pingable + queues initialized + sessions restore done                     |
| `/health/version`   | 200         | `{ git_sha, git_ref, build_time, image, color, pid, uptime_s }`                               |

The orchestrator polls `/health/ready` on the staged color and refuses
to flip Caddy until it returns 200.

---

## 6. Auto-rollback

The orchestrator aborts and leaves traffic on the **old** color when
any of these fail:

- pre-flight migration `--check` fails
- `--apply` fails (transaction rolls back)
- new container fails to start
- new color fails `/health/ready` within `ROLLOUT_HEALTH_TIMEOUT_MS`
- Caddy `POST /load` returns non-2xx

In all of these cases, the staged color is stopped, the deployment row
is marked `failed`, and `bin/upgrade` exits non-zero. Production traffic
is unaffected.

---

## 7. Recovery scenarios

### 7.1 Lock stuck after a crash

If `bin/upgrade` was killed mid-deploy, `state/upgrade.lock` may remain.
Verify no deploy is running, then:

```bash
rm /opt/web-pannel/state/upgrade.lock
```

### 7.2 Caddy is in a bad state

Caddy keeps the previous config when `POST /load` rejects new config,
so this should be rare. If it does happen:

```bash
docker compose restart caddy
./bin/upgrade deploy --ref <last-known-good-sha>
```

### 7.3 Rolling Postgres back from a backup

```bash
docker compose stop backend-blue backend-green
gunzip -c backups/<ts>/postgres.dump | \
  docker compose exec -T postgres pg_restore \
    -U postgres -p 5435 -d telegram_panel --clean --if-exists
docker compose start backend-blue   # whichever color was active before
```

### 7.4 Redis appendonly

Redis runs with `--appendonly yes` (see `docker-compose.yml`), so even
if the snapshot in `backups/<ts>/redis.rdb` is older than the crash,
Redis will replay AOF on startup.

### 7.5 Frontend updates

The frontend is now part of the same blue/green flow as the backend.
A normal `./bin/upgrade deploy --ref <ref>` builds a fresh
`web-pannel-frontend:<short-sha>` image, brings up the inactive
`frontend-<color>` container, waits for nginx to serve "/" with a 200,
then flips Caddy's `handle { ... }` upstream to the new color in the
SAME admin POST that flipped the backend. The old `frontend-<color>`
container is stopped after the drain interval.

If you want to ship ONLY a backend hotfix without rebuilding the SPA
bundle (rare — saves 30-90 seconds on the deploy), set
`UPGRADE_SKIP_FRONTEND=true` for that one deploy:

```bash
UPGRADE_SKIP_FRONTEND=true ./bin/upgrade deploy --ref hotfix-branch
```

The orchestrator will leave the frontend on whatever color was active
before. Use sparingly — if the SPA expects an API shape that only the
new backend serves, you'll get runtime errors in the browser.

#### Why the operator's "I deployed but I don't see changes" was real

The pre-blue/green topology had a single `frontend` service that the
orchestrator never touched. Running `./bin/upgrade deploy` rebuilt and
swapped the backend image, but the SPA bundle baked into the
`frontend` container kept serving the OLD JavaScript until the
operator manually ran `docker compose build frontend && docker
compose up -d frontend`. The new lockstep flow makes that step
unnecessary AND atomic — the SPA and the API switch in the same
admin POST so end users never see the old bundle making calls
against new API shapes.

---

## 8. Operator checklist before every deploy

- [ ] PR is merged to `main` (or the SHA you want is pushed).
- [ ] CI's build-backend.yml succeeded if you're using registry mode.
- [ ] Disk has > 5 GB free (backups + image layers).
- [ ] You're connected via screen/tmux (a 30-60 s deploy survives, but
      best to be safe).
- [ ] If this is the first time deploying a destructive migration,
      double-check it's been split into two PRs per
      `docs/MIGRATIONS.md`.

---

## 9. FAQ

**Q: What happens to a user who's mid-API-request when traffic flips?**
The request finishes on the old color (Caddy holds the upstream
connection until the response completes). The next request goes to the
new color.

**Q: What about WebSocket clients?**
They stay connected to the old color until either (a) the user closes
the tab, or (b) the old color is stopped after `DRAIN_GRACE_MS`. When
disconnect happens, the browser auto-reconnects via Socket.IO and lands
on the new color.

**Q: Do live MTProto sessions stay logged in across an upgrade?**
Yes. Every session row with `is_logged_in=TRUE` and `keep_alive=TRUE`
is restored from disk on the new backend color's boot via
`restoreAllLoggedInSessions()` — the GramJS string session is
re-decrypted, a fresh TelegramClient is built with the same auth_key,
proxy, and persisted device identity, and reconnected to the same DC.
The old color keeps its in-memory clients running for `DRAIN_GRACE_MS`
(default 25s) so live actions in flight on the previous color
complete cleanly. Auth keys are NOT regenerated, so Telegram does not
see the upgrade as a logout/login event. Sessions created with
`loginOnPanel=false` (parked, `keep_alive=FALSE`) are intentionally
NOT restored — the user opted them out of the panel's heartbeat — and
must be promoted with `POST /sessions/:id/login` first.

**Q: My deploy says "OK" but the browser still shows the old SPA.**
That's the bug the frontend blue/green flow was added to fix. Make
sure your stack has been brought up at least once with the new
docker-compose.yml (which adds `frontend-blue` / `frontend-green`),
then run `./bin/upgrade deploy --ref main`. The first deploy after
upgrading will detect and remove the legacy `frontend` container.
You can confirm the active SPA color with `./bin/upgrade status` —
the line `Active frontend color:` flips on every successful deploy.

**Q: Is there a global maintenance mode?**
No, and that's intentional — the whole point is no downtime. If you
truly need to take the panel offline, stop both colors:
`docker compose stop backend-blue backend-green`.

**Q: Can I run the orchestrator from my laptop instead of the VPS?**
Not recommended — the orchestrator needs access to the docker socket
and the repo. Just `ssh vps && ./bin/upgrade deploy ...` or use the
Telegram bot.

**Q: How do I see what's been deployed historically?**
`./bin/upgrade status` shows the last 10 deploys. The `deployments`
table in Postgres has the full history. Audit log file is at
`logs/upgrade-audit.log`.
