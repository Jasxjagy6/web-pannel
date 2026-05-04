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
   │   └── /            → frontend:83  (static SPA)
   │
   └────── /api/*       → backend-blue OR backend-green
           /socket.io/*

 postgres :5435   named volume postgres_data
 redis    :6382   named volume redis_data
 uploads          named volume uploads_data
 sessions         named volume sessions_data
 logs             named volume logs_data
 state            named volume state_data
```

Two backend containers exist, but only one (`blue` or `green`) is
serving traffic at any moment. The orchestrator starts the inactive
color with the new image, waits for `/health/ready`, atomically tells
Caddy to switch upstreams, drains the old color, and stops it.

Postgres, Redis, the frontend container, and the persistent volumes are
**never** restarted during a normal deploy.

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

This starts: postgres, redis, frontend, caddy, backend-blue, admin-bot
(only if the bot env vars are set).

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
6. Starts the inactive color (`backend-green` if blue is active).
7. Polls `/health/ready` on the new color (DB+Redis pingable, queues
   initialized, sessions restore loop done) up to
   `ROLLOUT_HEALTH_TIMEOUT_MS` (default 120s).
8. POSTs a fresh Caddy config to `127.0.0.1:2019/load`. Cutover happens
   atomically — new requests go to the new color; in-flight requests
   finish on the old upstream.
9. Sleeps `DRAIN_GRACE_MS` (default 25s) so live Socket.IO clients
   reconnect to the new color.
10. Stops the old backend container.
11. Updates `state/active-color.json` and inserts a row in the
    `deployments` table.

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

The frontend nginx is a single stateless container. To deploy a new
frontend image:

```bash
docker compose build frontend && docker compose up -d frontend
```

Caddy will route to the new frontend on its next health check (10s).
There is no blue/green here because the frontend has no in-memory
state.

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
