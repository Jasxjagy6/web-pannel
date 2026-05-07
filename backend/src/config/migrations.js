/**
 * Migration framework.
 *
 * - Tracks applied migrations in `schema_migrations(name, applied_at, checksum)`.
 * - Discovers `migration_*.sql` files in this directory automatically; explicit
 *   ordering can be specified in `MIGRATION_ORDER` below for files that have a
 *   meaningful sequence (the existing v2..v14 chain). Newly-added files appear
 *   in lexicographic order after the explicit chain.
 * - Each migration runs inside its own transaction. If it fails, the
 *   transaction rolls back and the migration is NOT recorded — the next run
 *   will retry it.
 * - `schema.sql` is always applied first (idempotent — it uses
 *   `CREATE TABLE IF NOT EXISTS`).
 *
 * The runner is consumed by:
 *   1. `bin/migrate.js` — CLI used by the upgrade orchestrator (--check / --apply).
 *   2. `config/database.js::initDB()` — keeps the legacy "apply on boot" behaviour
 *      so dev / single-instance deploys still work without the orchestrator.
 *
 * Forward-compatibility rules for new migrations are documented in
 * `docs/MIGRATIONS.md`. In short: additive only, nullable / default-valued,
 * `CREATE INDEX CONCURRENTLY` outside transactions when possible.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIGRATIONS_DIR = __dirname;

// Explicit order for the historical migrations. Anything not listed here is
// appended in lexicographic order after these. Migrations added by the
// dynamic-upgrade work (deployments table etc.) live in this list too.
const MIGRATION_ORDER = [
  'migration_scraping_upgrade.sql',
  'migration_v2_upgrades.sql',
  'migration_group_operations_ownership.sql',
  'migration_v3_antidetect.sql',
  'migration_v4_privacy.sql',
  'migration_v5_multiuser.sql',
  'migration_v6_scrape_monitor.sql',
  'migration_v7_billing.sql',
  'migration_v8_per_user_api_and_auto_approve.sql',
  'migration_v9_multiplatform.sql',
  'migration_v9_2_instagram_extras.sql',
  'migration_v9_3_subscription_split.sql',
  'migration_v10_monitor_dedup_toggle.sql',
  'migration_v11_instagram_session_columns.sql',
  'migration_v12_ig_anti_ban.sql',
  'migration_v13_tg_anti_revoke.sql',
  'migration_v14_user_proxies.sql',
  'migration_v15_deployments.sql',
  'migration_v16_session_fk_cascade.sql',
  'migration_v17_tg_anti_revoke_phase4.sql',
  'migration_v18_tg_otp_relay.sql',
  'migration_v19_rich_scrape_fields.sql',
  'migration_v20_session_lists.sql',
  'migration_v21_message_logs_target_id_text.sql',
  'migration_v22_proxy_providers.sql',
];

function listMigrationFiles() {
  const all = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^migration_.*\.sql$/.test(f));
  const ordered = [];
  const seen = new Set();
  for (const name of MIGRATION_ORDER) {
    if (all.includes(name) && !seen.has(name)) {
      ordered.push(name);
      seen.add(name);
    }
  }
  for (const name of all.sort()) {
    if (!seen.has(name)) {
      ordered.push(name);
      seen.add(name);
    }
  }
  return ordered;
}

function checksum(sql) {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

async function ensureSchemaMigrationsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      checksum    TEXT NOT NULL
    )
  `);
}

async function appliedMigrations(pool) {
  await ensureSchemaMigrationsTable(pool);
  const { rows } = await pool.query('SELECT name, checksum FROM schema_migrations');
  const map = new Map();
  for (const r of rows) map.set(r.name, r.checksum);
  return map;
}

/**
 * Returns the list of migrations that haven't been applied yet.
 * Each entry is { name, file, sql, checksum }.
 *
 * Migrations whose file checksum changed AFTER they were applied are reported
 * via `mismatched` (the operator must investigate; we never re-apply them
 * automatically). The legacy behaviour was to re-run every migration on every
 * boot, so on first contact with this runner every existing migration is
 * recorded as already applied with its current checksum (see `seedAllAsApplied`).
 */
async function listPending(pool) {
  const applied = await appliedMigrations(pool);
  const pending = [];
  const mismatched = [];
  for (const file of listMigrationFiles()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const cs = checksum(sql);
    const prev = applied.get(file);
    if (prev === undefined) {
      pending.push({ name: file, file, sql, checksum: cs });
    } else if (prev !== cs) {
      mismatched.push({ name: file, file, expected: prev, current: cs });
    }
  }
  return { pending, mismatched };
}

/**
 * Apply all pending migrations. Each runs inside its own transaction so a
 * partial failure leaves the schema and the schema_migrations table in sync.
 */
async function applyPending(pool, { logger = console } = {}) {
  const { pending, mismatched } = await listPending(pool);
  if (mismatched.length > 0) {
    for (const m of mismatched) {
      logger.warn(
        `[migrations] checksum mismatch for ${m.name}; ignoring (manual review required).`
      );
    }
  }
  if (pending.length === 0) {
    logger.log('[migrations] nothing to apply.');
    return { applied: [], mismatched };
  }
  const applied = [];
  for (const m of pending) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(m.sql);
      await client.query(
        'INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2) ' +
          'ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = NOW()',
        [m.name, m.checksum]
      );
      await client.query('COMMIT');
      logger.log(`[migrations] applied ${m.name}`);
      applied.push(m.name);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      logger.error(`[migrations] FAILED ${m.name}: ${err.message}`);
      throw err;
    } finally {
      client.release();
    }
  }
  return { applied, mismatched };
}

/**
 * One-time bridging shim: on a database that pre-dates this runner, every
 * migration_*.sql in the repo was already applied (the legacy code re-ran
 * them on every boot). Record them all as applied with their current
 * checksums so the new runner doesn't try to re-apply them. Safe to call
 * repeatedly — only inserts rows that don't already exist.
 *
 * Detection logic — we want this to fire on a *previously-deployed* database
 * AND be a no-op on a *fresh* database, so we look for an artifact that
 * could only have come from a pre-v15 migration actually executing. We pick
 * `proxies.user_id` (added by `migration_v14_user_proxies.sql`) because:
 *
 *   - `proxies` is created by `migration_scraping_upgrade.sql`, NOT by
 *     `schema.sql`; on a fresh DB it doesn't exist at all.
 *   - The `user_id` column on `proxies` is added by the latest pre-v15
 *     migration (v14). If it's present, the legacy boot loop has run all
 *     historical migrations end-to-end, so they are effectively applied.
 *   - Using a marker that ONLY a migration creates avoids the v15.0 bug
 *     where the presence of `users` (created by schema.sql) was treated as
 *     proof of pre-existing migrations, causing the seed to fire on every
 *     fresh DB and skip every historical migration.
 */
async function seedHistoryIfPreExisting(pool, { logger = console } = {}) {
  await ensureSchemaMigrationsTable(pool);

  const { rows: anyApplied } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM schema_migrations'
  );
  if (anyApplied[0].n > 0) return;

  const { rows: hasMarker } = await pool.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'proxies'
         AND column_name  = 'user_id'
    ) AS exists
  `);
  if (!hasMarker[0].exists) return;

  const files = listMigrationFiles();
  let seeded = 0;
  for (const file of files) {
    // Only seed migrations that pre-date this PR. The new ones (v15+) must
    // actually run against existing databases.
    if (!MIGRATION_ORDER.includes(file)) continue;
    if (file.startsWith('migration_v15_')) continue;
    if (file.startsWith('migration_v16_')) continue;
    if (file.startsWith('migration_v17_')) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await pool.query(
      'INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [file, checksum(sql)]
    );
    seeded++;
  }
  if (seeded > 0) {
    logger.log(`[migrations] seeded ${seeded} pre-existing migrations into schema_migrations.`);
  }
}

async function applySchemaSql(pool, { logger = console } = {}) {
  const schemaPath = path.join(MIGRATIONS_DIR, 'schema.sql');
  if (!fs.existsSync(schemaPath)) return;
  const schema = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(schema);
  logger.log('[migrations] base schema applied.');
}

module.exports = {
  listMigrationFiles,
  listPending,
  applyPending,
  applySchemaSql,
  seedHistoryIfPreExisting,
  ensureSchemaMigrationsTable,
};
