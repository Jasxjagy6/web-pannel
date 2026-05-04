# Database Migration Rules

This document is **mandatory reading** before you write a new
migration. The zero-downtime deploy system relies on every migration
being **forward-compatible**: during a deploy, both the old code (still
running on the active color) and the new code (just starting on the
inactive color) talk to the database for ~30 seconds. Any migration
that breaks the old code's contract with the database will cause
errors visible to live users.

---

## How the runner works

- Migrations live in `backend/src/config/migration_*.sql`.
- They are tracked in a `schema_migrations(name, applied_at, checksum)`
  table.
- The runner is `backend/src/config/migrations.js`. It is exposed as
  `node bin/migrate.js [--check|--apply|--list]`.
- Each migration runs inside its own Postgres transaction. A failure
  rolls back the schema AND prevents the row from being inserted into
  `schema_migrations`, so re-running picks up where it left off.
- The orchestrator runs `bin/migrate.js --apply` from inside a one-shot
  container of the **new** image, BEFORE flipping traffic. Old code
  keeps running with the new schema for ~30 seconds.

---

## The forward-compatibility rule

> **A migration must leave the database in a state where the OLD code
> still works correctly.**

The reason: during the cutover window, blue (old code) is still
serving requests against the new schema.

### What's safe

- `ADD COLUMN ... NULL` (or with a `DEFAULT`): the old code ignores it.
- `CREATE TABLE`: the old code never reads from it.
- `CREATE INDEX [CONCURRENTLY]`: indexes never break old code.
- `CREATE OR REPLACE VIEW` (when the new view's columns are a superset
  of the old one).
- `ALTER TYPE ... ADD VALUE` for enums (Postgres ≥ 12 — requires the
  migration NOT be in a transaction, so split into a small dedicated
  migration).
- Adding a foreign key constraint as `NOT VALID` and validating it in
  a follow-up migration once both colors are running new code.

### What's NOT safe in a single deploy

- `DROP COLUMN` — old code expects the column to exist.
- `RENAME COLUMN` — old code looks up the old name.
- `ALTER COLUMN ... NOT NULL` without a default — old code might
  insert NULLs.
- Type changes that lose precision.
- Renaming or dropping tables.
- Tightening a `CHECK` or unique constraint that old code's writes
  could violate.

For these, **split into two PRs across two deploys**:

| PR / deploy | Migration                                                                                  | Code change                                |
| ----------- | ------------------------------------------------------------------------------------------ | ------------------------------------------ |
| #1          | Add the new column / table / index. Backfill it from the old one. Update writes to do BOTH. | Code reads new + old, writes new + old.    |
| #2          | Drop the old column / table / index.                                                       | Code reads new only, writes new only.      |

Wait at least 24 hours between #1 and #2 so any rolled-back deploy still
has the old schema.

---

## File naming

`migration_v<N>_<short_name>.sql` — pick the next sequential `N`.

The current chain ends at `migration_v15_deployments.sql`. New migrations
are appended in lexicographic order.

You do NOT need to register the file anywhere — the runner discovers
all `migration_*.sql` files automatically. The optional explicit order
list in `migrations.js::MIGRATION_ORDER` exists only to preserve the
historical sequence; new migrations slot in after it in name order.

---

## Idempotency

Every migration must be safe to re-run. Use:

- `CREATE TABLE IF NOT EXISTS`
- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
- `CREATE INDEX IF NOT EXISTS`
- `INSERT ... ON CONFLICT DO NOTHING`

The runner records a checksum for each applied migration. If the file
contents change AFTER it was applied, the runner emits a warning and
will NOT re-apply. To fix a botched migration, ship a NEW migration
that corrects the data — never edit an applied file.

---

## Common patterns

### Adding a new column with a default

```sql
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
```

Postgres ≥ 11 fills `DEFAULT` lazily — no full table rewrite. Safe
even on hot tables.

### Adding an index without locking

```sql
-- IMPORTANT: CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction. Put it in its own migration file with no other
-- statements so the runner doesn't wrap it.
CREATE INDEX CONCURRENTLY IF NOT EXISTS
  idx_sessions_user_id_created_at
  ON sessions (user_id, created_at DESC);
```

Note: our runner currently wraps each migration in BEGIN/COMMIT. If you
need `CONCURRENTLY`, run it manually outside the runner via
`./bin/upgrade migrate --apply` AFTER editing the file to drop the
`CONCURRENTLY` keyword, OR run the index creation by hand and then add
a no-op `CREATE INDEX IF NOT EXISTS` migration so the runner records it.

### Renaming a column (the safe two-step)

PR #1:
```sql
ALTER TABLE billing_invoices
  ADD COLUMN IF NOT EXISTS amount_cents INTEGER;
UPDATE billing_invoices SET amount_cents = ROUND(amount * 100)
  WHERE amount_cents IS NULL;
```
…and update the code to write to BOTH `amount` and `amount_cents`.

PR #2 (after PR #1 is in production for 24h):
```sql
ALTER TABLE billing_invoices DROP COLUMN amount;
```
…and update the code to read/write only `amount_cents`.

### Adding a foreign key

```sql
ALTER TABLE scrape_jobs
  ADD CONSTRAINT scrape_jobs_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID;
```

Validate later (after backfill):
```sql
ALTER TABLE scrape_jobs VALIDATE CONSTRAINT scrape_jobs_user_id_fkey;
```

---

## Pre-deploy migration check

The orchestrator runs `bin/migrate.js --check` inside a one-shot
container of the new image before doing anything else. It exits
non-zero if any migration is pending (which is informational only — the
orchestrator then runs `--apply`) or if any applied migration's
checksum doesn't match the file in the new image (which IS a hard fail
— investigate manually).

You can run it locally to confirm a migration applies cleanly:

```bash
docker compose run --rm backend-blue node bin/migrate.js --apply
```

…or from the VPS:

```bash
./bin/upgrade migrate --check
./bin/upgrade migrate --apply
```

---

## When in doubt, ship the column add now and the column drop later

It is always better to leave dead columns / unused indexes around for
a release than to break the live deploy. They cost almost nothing to
keep around. Schema cleanup PRs ship at any cadence — production
correctness during cutover is the priority.
