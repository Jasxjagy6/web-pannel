# Isolated Staging

Staging runs the complete panel, including API routes, Socket.IO, queues, session restore, and all background workers. Its Postgres, Redis, uploads, logs, and Telegram session storage are separate Docker resources under the fixed `web-pannel-staging` Compose project. Postgres and Redis are additionally confined to an internal staging data network.

Staging is not a copy of production. Never import or mount production databases, Redis data, uploads, session directories, GramJS/Telethon session strings, Telegram auth keys, browser cookies, backups, or environment files.

## Required workflow

Every feature follows this promotion path:

`feature branch -> staging -> acceptance -> production`

Production deployment is allowed only after the feature branch has run in this staging stack and acceptance checks have passed.

## Bootstrap secrets

Create the two ignored environment files:

```bash
cp .env.staging.example .env.staging
cp backend/.env.example backend/.env.staging
```

Use `backend/.env.staging.example` as the staging override checklist. Keeping the full copy of `backend/.env.example` preserves every current feature knob; replace the critical DB, Redis, JWT, session-encryption, admin, upload, CORS, and deploy values with staging-only values.

Generate independent staging secrets, for example:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

Use a different generated value for each secret. The Postgres and Redis values in `.env.staging` are authoritative because Compose injects them into both the physical data services and backend. Do not reuse production values.

If environment files live elsewhere, keep `staging`, `test`, or `qa` in their filenames and configure them explicitly:

```bash
STAGING_ENV_FILE=/secure/config/panel.staging.env \
  STAGING_COMPOSE_FILE=./docker-compose.staging.yml \
  ./scripts/validate-staging-isolation.sh
```

Set `STAGING_BACKEND_ENV_FILE` inside the Compose env file to configure the backend env-file path. That path must refer only to staging configuration.

## External accounts

`ALLOW_TEST_EXTERNAL_ACCOUNTS=true` is a deliberate staging safety acknowledgement, not permission to use live accounts. Supply only external accounts and API credentials created specifically for staging tests:

- Telegram API credentials belonging to a test application.
- Telegram accounts and session auth keys created only for staging.
- Test Instagram, Reddit, email, payment sandbox, AI provider, proxy provider, and webhook accounts.
- Sandbox callback URLs that resolve to the staging gateway.

Never log a production Telegram account into staging. Never connect a production Telegram session string or auth key, even temporarily.

## Validate isolation

Run the fail-closed validator before every start or migration:

```bash
STAGING_ENV_FILE=.env.staging ./scripts/validate-staging-isolation.sh
```

It renders Compose without printing the rendered environment and rejects production resource names, the production database name, external or production networks/volumes, host aliases, Docker socket access, repository mounts, non-loopback gateway binding, and any DB/Redis host port publication.

## Schema and migrations

On a new staging database, initialize the base schema and apply pending migrations before the acceptance run:

```bash
docker compose --env-file .env.staging -f docker-compose.staging.yml \
  run --rm staging-backend node bin/migrate.js --apply-schema
docker compose --env-file .env.staging -f docker-compose.staging.yml \
  run --rm staging-backend node bin/migrate.js --apply
```

These commands may start only the staging Postgres and Redis dependencies. They must never be run with production Compose or production environment files. Normal backend boot also applies the idempotent schema and pending migrations when `SKIP_BOOT_MIGRATIONS=false`.

## Start

The gateway defaults to `127.0.0.1:8080`; Postgres and Redis have no published ports.

```bash
STAGING_ENV_FILE=.env.staging ./scripts/validate-staging-isolation.sh
docker compose --env-file .env.staging -f docker-compose.staging.yml up -d --build
```

For remote acceptance, keep the gateway loopback-only and use an SSH tunnel:

```bash
ssh -L 8080:127.0.0.1:8080 staging-host
```

Then open `http://127.0.0.1:8080` locally.

## Acceptance checks

Check the same-origin gateway paths:

```bash
curl --fail --silent --show-error http://127.0.0.1:8080/ >/dev/null
curl --fail --silent --show-error http://127.0.0.1:8080/health
curl --fail --silent --show-error http://127.0.0.1:8080/health/ready
curl --fail --silent --show-error \
  'http://127.0.0.1:8080/socket.io/?EIO=4&transport=polling'
```

The Socket.IO polling check should return an Engine.IO open packet beginning with `0`. Complete feature acceptance through the browser with test-only accounts, including the feature's API, queue/worker progress, persistence, reconnect behavior, and failure path.

Record the tested feature branch or commit and the acceptance result before promoting that exact revision to production.

## Stop and reset

Stop staging without deleting its isolated state:

```bash
docker compose --env-file .env.staging -f docker-compose.staging.yml down
```

Delete only staging data when a clean-room test is required:

```bash
docker compose --env-file .env.staging -f docker-compose.staging.yml down --volumes
```

Confirm the command uses `docker-compose.staging.yml` before adding `--volumes`. Do not seed the replacement environment from production backups or session files.
