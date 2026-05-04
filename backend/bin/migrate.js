#!/usr/bin/env node
/**
 * Migration CLI used by the upgrade orchestrator.
 *
 * Modes:
 *   --check    list pending migrations; exit 1 if any pending or any checksum
 *              mismatch is detected.
 *   --apply    apply all pending migrations. Each runs in its own transaction.
 *   --list     print every migration with its applied / pending status.
 *
 * Run inside the new image BEFORE flipping traffic in `bin/upgrade`. The
 * orchestrator stops the deploy if `--check` exits non-zero unexpectedly,
 * and aborts the cutover if `--apply` fails.
 *
 * The CLI re-uses the production pg pool config from `src/config/database.js`.
 * It does NOT load any service modules, so it's safe to run inside a brand-new
 * image whose dependencies haven't been wired together yet.
 */
require('dotenv').config();
const { Pool } = require('pg');

const migrations = require('../src/config/migrations');

function makePool() {
  return new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5435', 10),
    database: process.env.DB_NAME || 'telegram_panel',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'your_secure_password',
    // Migration runs are short — no need for a big pool.
    max: parseInt(process.env.MIGRATE_POOL_MAX || '4', 10),
    connectionTimeoutMillis: parseInt(process.env.DB_POOL_CONNECT_MS || '10000', 10),
  });
}

function parseArgs(argv) {
  const args = { check: false, apply: false, list: false, applySchema: false, json: false };
  for (const a of argv.slice(2)) {
    if (a === '--check') args.check = true;
    else if (a === '--apply') args.apply = true;
    else if (a === '--list') args.list = true;
    else if (a === '--apply-schema') args.applySchema = true;
    else if (a === '--json') args.json = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else { args.unknown = a; }
  }
  return args;
}

function usage() {
  console.log(`migrate.js — schema migration runner

Usage:
  node bin/migrate.js --check          # exit 1 if anything is pending or mismatched
  node bin/migrate.js --apply          # apply all pending migrations
  node bin/migrate.js --apply-schema   # apply schema.sql (CREATE TABLE IF NOT EXISTS)
  node bin/migrate.js --list           # print all migrations with status

  --json    machine-readable output (used by bin/upgrade)
`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || (!args.check && !args.apply && !args.list && !args.applySchema)) {
    usage();
    process.exit(args.help ? 0 : 2);
  }
  if (args.unknown) {
    console.error(`unknown argument: ${args.unknown}`);
    usage();
    process.exit(2);
  }

  const pool = makePool();
  try {
    if (args.applySchema) {
      await migrations.applySchemaSql(pool);
    }

    // Always seed history first so we don't try to re-run pre-existing
    // migrations against a database that pre-dates this runner.
    await migrations.seedHistoryIfPreExisting(pool);

    if (args.list) {
      const { pending, mismatched } = await migrations.listPending(pool);
      const allFiles = migrations.listMigrationFiles();
      const pendingNames = new Set(pending.map((p) => p.name));
      if (args.json) {
        console.log(JSON.stringify({
          all: allFiles,
          pending: pending.map((p) => p.name),
          mismatched,
        }, null, 2));
      } else {
        for (const f of allFiles) {
          const flag = pendingNames.has(f) ? 'PENDING ' : 'applied ';
          console.log(`  ${flag} ${f}`);
        }
        if (mismatched.length) {
          console.log('\nChecksum mismatches (manual review required):');
          for (const m of mismatched) console.log(`  ${m.name}`);
        }
      }
      process.exit(0);
    }

    if (args.check) {
      const { pending, mismatched } = await migrations.listPending(pool);
      const out = {
        pending: pending.map((p) => p.name),
        mismatched: mismatched.map((m) => m.name),
      };
      if (args.json) {
        console.log(JSON.stringify(out));
      } else if (pending.length === 0 && mismatched.length === 0) {
        console.log('migrate: up to date.');
      } else {
        if (pending.length) console.log(`migrate: ${pending.length} pending — ${out.pending.join(', ')}`);
        if (mismatched.length) console.log(`migrate: ${mismatched.length} checksum mismatches — ${out.mismatched.join(', ')}`);
      }
      process.exit(pending.length === 0 && mismatched.length === 0 ? 0 : 1);
    }

    if (args.apply) {
      const result = await migrations.applyPending(pool, { logger: console });
      if (args.json) {
        console.log(JSON.stringify(result));
      } else {
        console.log(`migrate: applied ${result.applied.length} migration(s).`);
      }
      process.exit(0);
    }
  } catch (err) {
    console.error(`migrate: error — ${err.message}`);
    process.exit(1);
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
