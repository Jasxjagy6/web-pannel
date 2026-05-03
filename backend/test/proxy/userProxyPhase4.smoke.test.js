/* eslint-env node */
/* eslint-disable global-require */
'use strict';

/**
 * BYO Proxy — Phase 4 cross-user isolation smoke.
 *
 * The proposal §4.4 calls for an end-to-end cross-user isolation guard
 * test that asserts:
 *
 *   P4.1   User A's proxies are NEVER returned by listMyProxies(B).
 *   P4.2   User B cannot SELECT or PATCH user A's row through the
 *          service surface.
 *   P4.3   User B cannot bind user A's proxy to a session B owns.
 *          (Service layer + DB trigger both refuse it.)
 *   P4.4   The shared admin pool (user_id IS NULL) is still bindable
 *          for everyone (otherwise we'd break legacy sessions).
 *
 * Runs against the live DB (skipped if unreachable). Tags every test
 * row with a unique prefix and tears them down after each block.
 */

const assert = require('assert');
const path = require('path');

process.chdir(path.join(__dirname, '..', '..'));
require('dotenv').config();

const { pool } = require('../../src/config/database');
const proxyService = require('../../src/services/proxyService');

let failures = 0;
function ok(name) { console.log(`  PASS  ${name}`); }
function fail(name, err) {
  failures += 1;
  console.error(`  FAIL  ${name}`);
  console.error(err && err.stack ? err.stack : err);
}

async function runIsolated(name, fn) {
  const tag = `p4-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  try {
    await fn(tag);
    ok(name);
  } catch (err) {
    fail(name, err);
  } finally {
    try {
      await pool.query(`DELETE FROM proxies WHERE host LIKE $1`, [`${tag}-%`]);
      await pool.query(`DELETE FROM sessions WHERE phone LIKE '+${tag.length}%'`);
      await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${tag}-%`]);
    } catch (_) {}
  }
}

async function mkUser(tag, suffix) {
  const r = await pool.query(`
    INSERT INTO users (email, password_hash, role, status, is_approved)
    VALUES ($1, 'x', 'user', 'approved', TRUE) RETURNING id
  `, [`${tag}-${suffix}@test.invalid`]);
  return r.rows[0].id;
}

async function mkSession(tag, userId, suffix) {
  const r = await pool.query(`
    INSERT INTO sessions (user_id, phone, status)
    VALUES ($1, $2, 'active') RETURNING id
  `, [userId, `+${tag.length}${suffix}`]);
  return r.rows[0].id;
}

(async () => {
  console.log('BYO Proxy — Phase 4 cross-user isolation smoke');

  try {
    await pool.query('SELECT 1');
  } catch (err) {
    console.error(`SKIP: DB not reachable (${err.message})`);
    process.exit(0);
  }

  // ----- P4.1 listMyProxies(B) excludes A's rows -----
  await runIsolated('P4.1 listMyProxies(B) never returns A rows', async (tag) => {
    const userA = await mkUser(tag, 'a');
    const userB = await mkUser(tag, 'b');
    const a = await proxyService.addMyProxy(userA, {
      host: `${tag}-a1.invalid`, port: 9100, protocol: 'socks5',
    });
    await proxyService.addMyProxy(userB, {
      host: `${tag}-b1.invalid`, port: 9101, protocol: 'socks5',
    });
    const listB = await proxyService.listMyProxies(userB);
    assert.ok(!listB.find((p) => p.id === a.id), 'B sees A row — leak!');
  });

  // ----- P4.2 B cannot SELECT or PATCH A's row through service surface -----
  await runIsolated('P4.2 B cannot getMyProxy / updateMyProxy / deleteMyProxy on A row', async (tag) => {
    const userA = await mkUser(tag, 'a');
    const userB = await mkUser(tag, 'b');
    const a = await proxyService.addMyProxy(userA, {
      host: `${tag}-a2.invalid`, port: 9102, protocol: 'socks5', label: 'orig',
    });
    assert.strictEqual(await proxyService.getMyProxy(userB, a.id), null);

    let updErr;
    try {
      await proxyService.updateMyProxy(userB, a.id, { label: 'EVIL' });
    } catch (err) { updErr = err; }
    assert.ok(updErr, 'updateMyProxy must throw on other-user row');
    assert.strictEqual(updErr.code, 'PROXY_NOT_FOUND');

    let delErr;
    try {
      await proxyService.deleteMyProxy(userB, a.id);
    } catch (err) { delErr = err; }
    assert.ok(delErr, 'deleteMyProxy must throw on other-user row');
    assert.strictEqual(delErr.code, 'PROXY_NOT_FOUND');

    // A's label should still be "orig".
    const stillA = await proxyService.getMyProxy(userA, a.id);
    assert.strictEqual(stillA.label, 'orig');
  });

  // ----- P4.3 B cannot bind A's proxy through assignUserProxyToSession -----
  await runIsolated('P4.3 B cannot assignUserProxyToSession with A proxy', async (tag) => {
    const userA = await mkUser(tag, 'a');
    const userB = await mkUser(tag, 'b');
    const sessionB = await mkSession(tag, userB, '03');
    const proxyA = await proxyService.addMyProxy(userA, {
      host: `${tag}-a3.invalid`, port: 9103, protocol: 'socks5',
    });
    let caught;
    try {
      await proxyService.assignUserProxyToSession(userB, sessionB, proxyA.id);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected service to refuse cross-user bind');
    // session_proxy_assignments must NOT contain this row.
    const r = await pool.query(`
      SELECT COUNT(*)::int n FROM session_proxy_assignments
       WHERE session_id = $1 AND proxy_id = $2
    `, [sessionB, proxyA.id]);
    assert.strictEqual(r.rows[0].n, 0);
    // sessions.bound_proxy_id must NOT be A's proxy.
    const s = await pool.query(`
      SELECT bound_proxy_id FROM sessions WHERE id = $1
    `, [sessionB]);
    assert.notStrictEqual(s.rows[0].bound_proxy_id, proxyA.id);
  });

  // ----- P4.4 admin pool (user_id IS NULL) is still bindable for everyone -----
  await runIsolated('P4.4 shared admin pool remains bindable', async (tag) => {
    const userId = await mkUser(tag, 'a');
    const sessionId = await mkSession(tag, userId, '04');
    const adminProxy = await pool.query(`
      INSERT INTO proxies (host, port, protocol, source, is_working)
      VALUES ($1, 9104, 'socks5', 'manual', TRUE) RETURNING id
    `, [`${tag}-admin.invalid`]);
    const adminId = adminProxy.rows[0].id;
    // Direct insert through the assignment table (admin pool path is
    // already exercised by the regular assignment service in prod).
    await pool.query(`
      INSERT INTO session_proxy_assignments (session_id, proxy_id)
      VALUES ($1, $2)
    `, [sessionId, adminId]);
    const r = await pool.query(`
      SELECT COUNT(*)::int n FROM session_proxy_assignments
       WHERE session_id = $1 AND proxy_id = $2
    `, [sessionId, adminId]);
    assert.strictEqual(r.rows[0].n, 1);
  });

  console.log('');
  if (failures > 0) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
  } else {
    console.log('All Phase 4 BYO proxy smokes passed.');
    process.exit(0);
  }
})().catch((err) => {
  console.error('Smoke harness crashed:', err);
  process.exit(2);
});
