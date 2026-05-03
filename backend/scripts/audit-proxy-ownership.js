#!/usr/bin/env node
/**
 * audit-proxy-ownership.js — BYO Proxy, Phase 1 audit script.
 *
 * Run after migration_v14_user_proxies.sql has been applied. Surfaces
 * every existing session_proxy_assignments row whose proxy.user_id is
 * neither NULL (shared admin pool, allowed) nor equal to the session's
 * user_id (cross-user binding, MUST be remediated before Phase 2 flips
 * REQUIRE_USER_PROXY=true).
 *
 * Phase 1's database trigger blocks any *new* cross-user binding, but
 * existing rows are not retroactively validated. This script gives ops
 * a list of sessions to manually re-bind before the cutover.
 *
 * Usage:
 *   node backend/scripts/audit-proxy-ownership.js
 *
 * Exit codes:
 *   0 — no violations
 *   1 — violations found (count printed to stderr)
 *   2 — DB error
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { pool } = require('../src/config/database');

async function main() {
  const r = await pool.query(`
    SELECT
      spa.session_id,
      s.user_id        AS session_user_id,
      spa.proxy_id,
      p.user_id        AS proxy_user_id,
      p.source         AS proxy_source,
      p.host           AS proxy_host,
      p.port           AS proxy_port,
      p.protocol       AS proxy_protocol,
      spa.assigned_at
    FROM session_proxy_assignments spa
    JOIN sessions s ON s.id = spa.session_id
    JOIN proxies  p ON p.id = spa.proxy_id
    ORDER BY spa.assigned_at DESC
  `);

  let violations = 0;
  let adminPool = 0;
  let userOwned = 0;
  const violationRows = [];

  for (const row of r.rows) {
    if (row.proxy_user_id === null) {
      adminPool += 1;
    } else if (row.proxy_user_id === row.session_user_id) {
      userOwned += 1;
    } else {
      violations += 1;
      violationRows.push(row);
    }
  }

  console.log('======================================================================');
  console.log('Proxy ownership audit (BYO Proxy Phase 1)');
  console.log('======================================================================');
  console.log(`Total bindings:           ${r.rowCount}`);
  console.log(`  Admin pool (allowed):   ${adminPool}`);
  console.log(`  User-owned (allowed):   ${userOwned}`);
  console.log(`  Cross-user (BAD):       ${violations}`);
  console.log('');

  if (violations > 0) {
    console.error('CROSS-USER PROXY BINDINGS DETECTED — these must be remediated');
    console.error('before flipping REQUIRE_USER_PROXY=true in Phase 2:');
    console.error('');
    for (const v of violationRows) {
      console.error(
        `  session_id=${v.session_id} (user_id=${v.session_user_id}) ` +
        `→ proxy_id=${v.proxy_id} (user_id=${v.proxy_user_id}, ` +
        `source=${v.proxy_source}, ${v.proxy_host}:${v.proxy_port}/${v.proxy_protocol})`
      );
    }
    console.error('');
    console.error('Remediation options:');
    console.error('  1. DELETE the binding (session pauses until a new proxy is assigned).');
    console.error('  2. Re-bind the session to one of the session-owner\'s own proxies.');
    console.error('  3. NULL the proxy.user_id (move it back to the shared admin pool).');
    console.error('');
    process.exit(1);
  }

  console.log('No violations — safe to roll out Phase 2.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Audit failed:', err.message);
  console.error(err.stack);
  process.exit(2);
});
