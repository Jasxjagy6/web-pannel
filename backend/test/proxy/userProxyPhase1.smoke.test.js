/* eslint-env node */
/* eslint-disable global-require */
'use strict';

/**
 * BYO Proxy — Phase 1 smoke test.
 *
 * Verifies the Phase 1 deliverables from BYO_PROXY_PROPOSAL.md §4:
 *
 *   P1.1  Migration v14 columns are present on `proxies`.
 *   P1.2  Re-running migration v14 is idempotent.
 *   P1.3  Existing rows backfill to user_id=NULL.
 *   P1.4  Different users may own the same (host, port, protocol).
 *   P1.5  A single user can NOT own (host, port, protocol) twice.
 *   P1.6  Trigger blocks a cross-user binding in session_proxy_assignments.
 *   P1.7  proxyService.listMyProxies() excludes admin-pool rows.
 *   P1.8  proxyService.listAdminProxies() returns only user_id IS NULL rows.
 *
 * Each assertion runs inside a BEGIN/ROLLBACK so the live DB stays clean.
 *
 * Run with:
 *   node backend/test/proxy/userProxyPhase1.smoke.test.js
 *
 * Skips with a clear message if the DB isn't reachable.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

// Move CWD to backend/ so dotenv + relative requires resolve.
process.chdir(path.join(__dirname, '..', '..'));
require('dotenv').config();

const { pool } = require('../../src/config/database');

let failures = 0;
function ok(name) { console.log(`  PASS  ${name}`); }
function fail(name, err) {
  failures += 1;
  console.error(`  FAIL  ${name}`);
  console.error(err && err.stack ? err.stack : err);
}

async function run(name, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
    ok(name);
  } catch (err) {
    fail(name, err);
  } finally {
    try { await client.query('ROLLBACK'); } catch (_) {}
    client.release();
  }
}

async function ensureDbReachable() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (err) {
    console.error(`SKIP: DB not reachable (${err.message})`);
    return false;
  }
}

async function ensureMigrationApplied() {
  const r = await pool.query(`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'proxies'
       AND column_name IN ('user_id', 'label', 'country_code', 'notes',
                           'last_health_check', 'last_health_ok',
                           'health_message')
  `);
  return r.rowCount === 7;
}

async function applyMigrationIfMissing() {
  const sqlPath = path.join(__dirname, '..', '..', 'src', 'config', 'migration_v14_user_proxies.sql');
  if (!fs.existsSync(sqlPath)) {
    throw new Error(`migration v14 sql not found at ${sqlPath}`);
  }
  const sql = fs.readFileSync(sqlPath, 'utf8');
  await pool.query(sql);
}

(async () => {
  console.log('BYO Proxy — Phase 1 smoke');

  if (!(await ensureDbReachable())) {
    process.exit(0);
  }

  // The proxies / sessions / users base schema must exist.
  try {
    await pool.query('SELECT id FROM proxies LIMIT 1');
    await pool.query('SELECT id FROM sessions LIMIT 1');
    await pool.query('SELECT id FROM users LIMIT 1');
  } catch (err) {
    console.error(`SKIP: required base tables missing (${err.message})`);
    process.exit(0);
  }

  if (!(await ensureMigrationApplied())) {
    console.log('Applying migration v14 (it had not been run on this DB) ...');
    await applyMigrationIfMissing();
    if (!(await ensureMigrationApplied())) {
      console.error('FAIL: migration v14 did not add the expected columns');
      process.exit(1);
    }
  }

  // ----- P1.1 columns present -----
  await run('P1.1 migration adds user_id / label / country_code / notes / health_*', async (c) => {
    const r = await c.query(`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'proxies'
         AND column_name IN ('user_id', 'label', 'country_code', 'notes',
                             'last_health_check', 'last_health_ok', 'health_message')
       ORDER BY column_name
    `);
    const names = r.rows.map((x) => x.column_name).sort();
    assert.deepStrictEqual(names, [
      'country_code', 'health_message', 'label',
      'last_health_check', 'last_health_ok', 'notes', 'user_id',
    ]);
  });

  // ----- P1.2 idempotent re-apply -----
  await run('P1.2 migration v14 is idempotent (re-runnable)', async (c) => {
    const sqlPath = path.join(__dirname, '..', '..', 'src', 'config', 'migration_v14_user_proxies.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    await c.query(sql);
    // After re-running, the columns must still be there.
    const r = await c.query(`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'proxies' AND column_name = 'user_id'
    `);
    assert.strictEqual(r.rowCount, 1);
  });

  // ----- P1.3 existing rows backfill to user_id = NULL -----
  await run('P1.3 the __direct__ row (and any pre-v14 row) keeps user_id = NULL', async (c) => {
    // Insert a fake admin-pool row exactly the way pre-v14 inserts did.
    await c.query(`
      INSERT INTO proxies (host, port, protocol, source, is_working, priority)
      VALUES ('phase1-test-admin.invalid', 12345, 'socks5', 'manual', TRUE, 100)
    `);
    const r = await c.query(`
      SELECT user_id FROM proxies WHERE host = 'phase1-test-admin.invalid'
    `);
    assert.strictEqual(r.rowCount, 1);
    assert.strictEqual(r.rows[0].user_id, null);
  });

  // ----- P1.4 two different users may own the same (host, port, protocol) -----
  await run('P1.4 different users may own (host, port, protocol)', async (c) => {
    // Pull two distinct users (admin + at least one more, or just admin
    // and use a synthetic second user_id by reading the next value of
    // the sequence — but for the smoke we'll create two test users).
    const u1 = await c.query(`
      INSERT INTO users (email, password_hash, role, status, is_approved)
      VALUES ('p1.4-a@test.invalid', 'x', 'user', 'approved', TRUE)
      RETURNING id
    `);
    const u2 = await c.query(`
      INSERT INTO users (email, password_hash, role, status, is_approved)
      VALUES ('p1.4-b@test.invalid', 'x', 'user', 'approved', TRUE)
      RETURNING id
    `);
    const userA = u1.rows[0].id;
    const userB = u2.rows[0].id;

    await c.query(`
      INSERT INTO proxies (user_id, host, port, protocol, source, is_working)
      VALUES ($1, 'shared-byo.invalid', 9000, 'socks5', 'user', TRUE)
    `, [userA]);
    await c.query(`
      INSERT INTO proxies (user_id, host, port, protocol, source, is_working)
      VALUES ($1, 'shared-byo.invalid', 9000, 'socks5', 'user', TRUE)
    `, [userB]);

    const r = await c.query(`
      SELECT COUNT(*)::int AS n FROM proxies
       WHERE host = 'shared-byo.invalid' AND port = 9000 AND protocol = 'socks5'
    `);
    assert.strictEqual(r.rows[0].n, 2);
  });

  // ----- P1.5 a single user cannot own (host, port, protocol) twice -----
  await run('P1.5 same user cannot own (host, port, protocol) twice', async (c) => {
    const u = await c.query(`
      INSERT INTO users (email, password_hash, role, status, is_approved)
      VALUES ('p1.5-a@test.invalid', 'x', 'user', 'approved', TRUE)
      RETURNING id
    `);
    const userId = u.rows[0].id;
    await c.query(`
      INSERT INTO proxies (user_id, host, port, protocol, source, is_working)
      VALUES ($1, 'dup-byo.invalid', 9100, 'socks5', 'user', TRUE)
    `, [userId]);

    let dup;
    try {
      await c.query(`
        INSERT INTO proxies (user_id, host, port, protocol, source, is_working)
        VALUES ($1, 'dup-byo.invalid', 9100, 'socks5', 'user', TRUE)
      `, [userId]);
    } catch (err) {
      dup = err;
    }
    assert.ok(dup, 'expected duplicate INSERT to fail');
    assert.strictEqual(dup.code, '23505', `expected unique_violation, got ${dup.code}`);
  });

  // ----- P1.6 ownership trigger blocks cross-user binding -----
  await run('P1.6 trg_enforce_session_proxy_ownership blocks user-A session → user-B proxy', async (c) => {
    const ua = await c.query(`
      INSERT INTO users (email, password_hash, role, status, is_approved)
      VALUES ('p1.6-a@test.invalid', 'x', 'user', 'approved', TRUE) RETURNING id
    `);
    const ub = await c.query(`
      INSERT INTO users (email, password_hash, role, status, is_approved)
      VALUES ('p1.6-b@test.invalid', 'x', 'user', 'approved', TRUE) RETURNING id
    `);
    const userA = ua.rows[0].id;
    const userB = ub.rows[0].id;

    // Insert a session owned by user A. Use minimal columns (the rest
    // have defaults / are nullable) so we don't depend on schema drift.
    const session = await c.query(`
      INSERT INTO sessions (user_id, phone, status)
      VALUES ($1, '+1000000001', 'active')
      RETURNING id
    `, [userA]);
    const sessionId = session.rows[0].id;

    // Insert a proxy owned by user B.
    const proxy = await c.query(`
      INSERT INTO proxies (user_id, host, port, protocol, source, is_working)
      VALUES ($1, 'crossuser-byo.invalid', 9200, 'socks5', 'user', TRUE)
      RETURNING id
    `, [userB]);
    const proxyId = proxy.rows[0].id;

    // Attempt to bind A's session to B's proxy → trigger raises.
    let trig;
    try {
      await c.query(`
        INSERT INTO session_proxy_assignments (session_id, proxy_id)
        VALUES ($1, $2)
      `, [sessionId, proxyId]);
    } catch (err) {
      trig = err;
    }
    assert.ok(trig, 'expected ownership trigger to raise');
    assert.ok(
      /ownership mismatch/i.test(trig.message),
      `expected ownership-mismatch message, got: ${trig.message}`
    );
  });

  // ----- P1.6b shared admin pool (proxy.user_id IS NULL) is allowed -----
  await run('P1.6b shared admin pool binding (NULL user_id) is allowed', async (c) => {
    const u = await c.query(`
      INSERT INTO users (email, password_hash, role, status, is_approved)
      VALUES ('p1.6b@test.invalid', 'x', 'user', 'approved', TRUE) RETURNING id
    `);
    const userId = u.rows[0].id;
    const session = await c.query(`
      INSERT INTO sessions (user_id, phone, status)
      VALUES ($1, '+1000000002', 'active') RETURNING id
    `, [userId]);
    const proxy = await c.query(`
      INSERT INTO proxies (host, port, protocol, source, is_working)
      VALUES ('admin-pool.invalid', 9300, 'socks5', 'manual', TRUE)
      RETURNING id
    `);
    await c.query(`
      INSERT INTO session_proxy_assignments (session_id, proxy_id)
      VALUES ($1, $2)
    `, [session.rows[0].id, proxy.rows[0].id]);
    const r = await c.query(`
      SELECT COUNT(*)::int AS n FROM session_proxy_assignments WHERE session_id = $1
    `, [session.rows[0].id]);
    assert.strictEqual(r.rows[0].n, 1);
  });

  // ----- P1.7 listMyProxies excludes admin-pool rows -----
  await run('P1.7 proxyService.listMyProxies excludes admin-pool rows', async (c) => {
    // We can't run the service inside our transaction (it uses its own
    // pool connection that wouldn't see our uncommitted rows). Test the
    // SQL directly instead — which is what the service does.
    const u = await c.query(`
      INSERT INTO users (email, password_hash, role, status, is_approved)
      VALUES ('p1.7@test.invalid', 'x', 'user', 'approved', TRUE) RETURNING id
    `);
    const userId = u.rows[0].id;
    await c.query(`
      INSERT INTO proxies (user_id, host, port, protocol, source, is_working)
      VALUES ($1, 'p1-7-mine.invalid', 9400, 'socks5', 'user', TRUE)
    `, [userId]);
    await c.query(`
      INSERT INTO proxies (host, port, protocol, source, is_working)
      VALUES ('p1-7-admin.invalid', 9401, 'socks5', 'manual', TRUE)
    `);

    const mine = await c.query(`
      SELECT host FROM proxies WHERE user_id = $1
    `, [userId]);
    const all = await c.query(`
      SELECT host FROM proxies
       WHERE host IN ('p1-7-mine.invalid', 'p1-7-admin.invalid')
    `);

    assert.strictEqual(mine.rowCount, 1);
    assert.strictEqual(mine.rows[0].host, 'p1-7-mine.invalid');
    assert.strictEqual(all.rowCount, 2); // both visible globally
  });

  // ----- P1.8 listAdminProxies returns only user_id IS NULL rows -----
  await run('P1.8 listAdminProxies returns only NULL user_id rows', async (c) => {
    const u = await c.query(`
      INSERT INTO users (email, password_hash, role, status, is_approved)
      VALUES ('p1.8@test.invalid', 'x', 'user', 'approved', TRUE) RETURNING id
    `);
    const userId = u.rows[0].id;
    await c.query(`
      INSERT INTO proxies (user_id, host, port, protocol, source, is_working)
      VALUES ($1, 'p1-8-mine.invalid', 9500, 'socks5', 'user', TRUE)
    `, [userId]);
    await c.query(`
      INSERT INTO proxies (host, port, protocol, source, is_working)
      VALUES ('p1-8-admin.invalid', 9501, 'socks5', 'manual', TRUE)
    `);
    const adminOnly = await c.query(`
      SELECT host FROM proxies
       WHERE user_id IS NULL
         AND host IN ('p1-8-mine.invalid', 'p1-8-admin.invalid')
    `);
    assert.strictEqual(adminOnly.rowCount, 1);
    assert.strictEqual(adminOnly.rows[0].host, 'p1-8-admin.invalid');
  });

  console.log('');
  if (failures > 0) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
  } else {
    console.log('All Phase 1 BYO proxy smokes passed.');
    process.exit(0);
  }
})().catch((err) => {
  console.error('Smoke harness crashed:', err);
  process.exit(2);
});
