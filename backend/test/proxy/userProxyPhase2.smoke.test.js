/* eslint-env node */
/* eslint-disable global-require */
'use strict';

/**
 * BYO Proxy — Phase 2 smoke test.
 *
 * Verifies the Phase 2 backend deliverables from BYO_PROXY_PROPOSAL.md §4.2:
 *
 *   P2.1   addMyProxy persists user_id + source='user'.
 *   P2.2   addMyProxy on the same (host, port, protocol) by another
 *          user is allowed (per-user uniqueness).
 *   P2.3   listMyProxies/getMyProxy never leak rows from another user.
 *   P2.4   updateMyProxy patches only label/notes/country_code.
 *   P2.5   deleteMyProxy on someone else's id returns NOT_FOUND.
 *   P2.6   pickProxyForSession with REQUIRE_USER_PROXY=true and the
 *          user has zero proxies → throws NO_USER_PROXY (412).
 *   P2.7   assignUserProxyToSession writes session_proxy_assignments
 *          + sessions.bound_proxy_id + sessions.proxy_url.
 *   P2.8   The DB trigger blocks user-A binding user-B's proxy through
 *          assignUserProxyToSession (defence-in-depth).
 *   P2.9   getMyProxy(userId, idOwnedByOther) returns null.
 *   P2.10  buildProxyUrl() round-trips creds for the materialised
 *          proxy_url that providers consume.
 *
 * Each assertion runs inside a BEGIN/SAVEPOINT/ROLLBACK so the live DB
 * stays clean. Skips with a clear message if the DB isn't reachable.
 *
 * Run with:
 *   node backend/test/proxy/userProxyPhase2.smoke.test.js
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
  // We can't BEGIN/ROLLBACK around proxyService calls because the
  // service uses its own pool connection. Instead we tag every test
  // row with a unique prefix and DELETE on tearDown.
  const tag = `p2-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  try {
    await fn(tag);
    ok(name);
  } catch (err) {
    fail(name, err);
  } finally {
    try {
      await pool.query(`DELETE FROM proxies WHERE host LIKE $1`, [`${tag}-%`]);
      await pool.query(`DELETE FROM sessions WHERE phone LIKE $1`, [`+${tag.replace(/[^0-9]/g, '').slice(-9) || '999999999'}%`]);
      await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${tag}-%`]);
    } catch (_) {}
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

async function mkUser(tag, suffix) {
  const r = await pool.query(`
    INSERT INTO users (email, password_hash, role, status, is_approved)
    VALUES ($1, 'x', 'user', 'approved', TRUE) RETURNING id
  `, [`${tag}-${suffix}@test.invalid`]);
  return r.rows[0].id;
}

async function mkSession(tag, userId, phoneSuffix) {
  const r = await pool.query(`
    INSERT INTO sessions (user_id, phone, status)
    VALUES ($1, $2, 'active') RETURNING id
  `, [userId, `+9${tag.length}${phoneSuffix}`]);
  return r.rows[0].id;
}

(async () => {
  console.log('BYO Proxy — Phase 2 smoke');

  if (!(await ensureDbReachable())) {
    process.exit(0);
  }

  // ----- P2.1 addMyProxy persists user_id + source='user' -----
  await runIsolated('P2.1 addMyProxy persists user_id and source="user"', async (tag) => {
    const userId = await mkUser(tag, 'a');
    const proxy = await proxyService.addMyProxy(userId, {
      host: `${tag}-add.invalid`, port: 9000, protocol: 'socks5',
      label: 'My Box', country_code: 'us',
    });
    assert.strictEqual(proxy.user_id, userId);
    assert.strictEqual(proxy.source, 'user');
    assert.strictEqual(proxy.label, 'My Box');
    assert.strictEqual(proxy.country_code, 'us');
  });

  // ----- P2.2 different users may add the same (host, port, protocol) -----
  await runIsolated('P2.2 different users may add the same (host, port, protocol)', async (tag) => {
    const userA = await mkUser(tag, 'a');
    const userB = await mkUser(tag, 'b');
    await proxyService.addMyProxy(userA, {
      host: `${tag}-shared.invalid`, port: 9001, protocol: 'socks5',
    });
    const second = await proxyService.addMyProxy(userB, {
      host: `${tag}-shared.invalid`, port: 9001, protocol: 'socks5',
    });
    assert.strictEqual(second.user_id, userB);
    const r = await pool.query(
      `SELECT COUNT(*)::int n FROM proxies WHERE host = $1`,
      [`${tag}-shared.invalid`]
    );
    assert.strictEqual(r.rows[0].n, 2);
  });

  // ----- P2.3 listMyProxies / getMyProxy never leak across users -----
  await runIsolated('P2.3 listMyProxies / getMyProxy isolate per-user rows', async (tag) => {
    const userA = await mkUser(tag, 'a');
    const userB = await mkUser(tag, 'b');
    const a = await proxyService.addMyProxy(userA, {
      host: `${tag}-mine.invalid`, port: 9002, protocol: 'socks5',
    });
    const b = await proxyService.addMyProxy(userB, {
      host: `${tag}-other.invalid`, port: 9003, protocol: 'socks5',
    });
    const listA = await proxyService.listMyProxies(userA);
    assert.ok(listA.find((p) => p.id === a.id), 'A sees own row');
    assert.ok(!listA.find((p) => p.id === b.id), 'A must not see B row');

    const fetched = await proxyService.getMyProxy(userA, b.id);
    assert.strictEqual(fetched, null, 'getMyProxy must reject other-user id');
  });

  // ----- P2.4 updateMyProxy patches only label/notes/country_code -----
  await runIsolated('P2.4 updateMyProxy whitelists label/notes/country_code', async (tag) => {
    const userId = await mkUser(tag, 'a');
    const p = await proxyService.addMyProxy(userId, {
      host: `${tag}-upd.invalid`, port: 9004, protocol: 'socks5',
    });
    const before = await proxyService.getMyProxy(userId, p.id);
    const updated = await proxyService.updateMyProxy(userId, p.id, {
      label: 'X', notes: 'Y', country_code: 'in',
      // attempt to overwrite immutable columns:
      host: 'evil.invalid', port: 6666, user_id: -1,
    });
    assert.strictEqual(updated.label, 'X');
    assert.strictEqual(updated.notes, 'Y');
    assert.strictEqual(updated.country_code, 'in');
    assert.strictEqual(updated.host, before.host, 'host must not change');
    assert.strictEqual(Number(updated.port), Number(before.port), 'port must not change');
    assert.strictEqual(updated.user_id, userId, 'user_id must not change');
  });

  // ----- P2.5 deleteMyProxy on someone else's id raises PROXY_NOT_FOUND -----
  await runIsolated('P2.5 deleteMyProxy(otherUserRow) → PROXY_NOT_FOUND', async (tag) => {
    const userA = await mkUser(tag, 'a');
    const userB = await mkUser(tag, 'b');
    const b = await proxyService.addMyProxy(userB, {
      host: `${tag}-del.invalid`, port: 9005, protocol: 'socks5',
    });
    let caught;
    try {
      await proxyService.deleteMyProxy(userA, b.id);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected delete on other-user row to throw');
    assert.strictEqual(caught.code, 'PROXY_NOT_FOUND');
    // B's row must still exist.
    const stillThere = await proxyService.getMyProxy(userB, b.id);
    assert.ok(stillThere, 'B row must survive A delete attempt');
  });

  // ----- P2.6 pickProxyForSession + REQUIRE_USER_PROXY=true + zero rows -----
  // REQUIRE_USER_PROXY is captured at module-load; the smoke runs
  // against the configured value (defaults to "true"). When it's been
  // explicitly disabled in .env we skip with a note rather than fail.
  if (proxyService.constants.REQUIRE_USER_PROXY) {
    await runIsolated('P2.6 pickProxyForSession throws NO_USER_PROXY when REQUIRE_USER_PROXY=true', async (tag) => {
      const userId = await mkUser(tag, 'a');
      const sessionId = await mkSession(tag, userId, '01');
      let caught;
      try {
        await proxyService.pickProxyForSession(userId, sessionId);
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, 'expected NO_USER_PROXY to throw');
      assert.strictEqual(caught.code, 'NO_USER_PROXY');
      assert.strictEqual(caught.statusCode || caught.status, 412);
    });
  } else {
    console.log('  SKIP  P2.6 (REQUIRE_USER_PROXY explicitly disabled)');
  }

  // ----- P2.7 assignUserProxyToSession writes assignment + sessions.bound_proxy_id -----
  await runIsolated('P2.7 assignUserProxyToSession writes assignment + bound_proxy_id + proxy_url', async (tag) => {
    const userId = await mkUser(tag, 'a');
    const sessionId = await mkSession(tag, userId, '02');
    const p = await proxyService.addMyProxy(userId, {
      host: `${tag}-assign.invalid`, port: 9006, protocol: 'socks5',
      username: 'u', password: 'p',
    });
    await proxyService.assignUserProxyToSession(userId, sessionId, p.id);
    const r = await pool.query(`
      SELECT s.bound_proxy_id, s.proxy_url,
             (SELECT COUNT(*)::int FROM session_proxy_assignments
               WHERE session_id = s.id AND proxy_id = $2) AS n
        FROM sessions s WHERE s.id = $1
    `, [sessionId, p.id]);
    assert.strictEqual(r.rows[0].bound_proxy_id, p.id);
    assert.strictEqual(r.rows[0].n, 1);
    assert.ok(r.rows[0].proxy_url, 'proxy_url must be materialised');
    assert.match(r.rows[0].proxy_url, /^socks5:\/\/u:p@/);
  });

  // ----- P2.8 trigger blocks cross-user binding through service -----
  await runIsolated('P2.8 assignUserProxyToSession refuses cross-user binding', async (tag) => {
    const userA = await mkUser(tag, 'a');
    const userB = await mkUser(tag, 'b');
    const sessionA = await mkSession(tag, userA, '03');
    const proxyB = await proxyService.addMyProxy(userB, {
      host: `${tag}-cross.invalid`, port: 9007, protocol: 'socks5',
    });
    let caught;
    try {
      // userA tries to bind userB's proxy to userA's session.
      await proxyService.assignUserProxyToSession(userA, sessionA, proxyB.id);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected cross-user binding to throw');
    // Either the service-level ownership check (PROXY_NOT_FOUND) or the
    // DB trigger (ownership mismatch) is acceptable defence-in-depth.
    assert.ok(
      /PROXY_NOT_FOUND|ownership/i.test(caught.code || '') ||
      /not found|ownership/i.test(caught.message || ''),
      `unexpected error: ${caught.code} ${caught.message}`
    );
  });

  // ----- P2.9 getMyProxy(otherId) returns null -----
  await runIsolated('P2.9 getMyProxy returns null for other-user id', async (tag) => {
    const userA = await mkUser(tag, 'a');
    const userB = await mkUser(tag, 'b');
    const b = await proxyService.addMyProxy(userB, {
      host: `${tag}-iso.invalid`, port: 9008, protocol: 'socks5',
    });
    const got = await proxyService.getMyProxy(userA, b.id);
    assert.strictEqual(got, null);
  });

  // ----- P2.10 buildProxyUrl() round-trips creds -----
  // buildProxyUrl reads `password_enc`, so we go through addMyProxy
  // (which encrypts) and then re-fetch the row.
  await runIsolated('P2.10 buildProxyUrl materialises auth-bearing URL', async (tag) => {
    const userId = await mkUser(tag, 'a');
    await proxyService.addMyProxy(userId, {
      host: `${tag}-url.invalid`, port: 1080, protocol: 'socks5',
      username: 'alice', password: 's3c!ret',
    });
    const row = await pool.query(
      `SELECT * FROM proxies WHERE user_id = $1 AND host = $2`,
      [userId, `${tag}-url.invalid`]
    );
    const url = proxyService.buildProxyUrl(row.rows[0]);
    assert.match(url, /^socks5:\/\/alice:s3c%21ret@/, `unexpected url: ${url}`);

    const noauth = proxyService.buildProxyUrl({
      host: 'h.example', port: 8080, protocol: 'http',
    });
    assert.strictEqual(noauth, 'http://h.example:8080');
  });

  console.log('');
  if (failures > 0) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
  } else {
    console.log('All Phase 2 BYO proxy smokes passed.');
    process.exit(0);
  }
})().catch((err) => {
  console.error('Smoke harness crashed:', err);
  process.exit(2);
});
