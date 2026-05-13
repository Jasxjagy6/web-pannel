/**
 * Smoke test for monitorOrchestrator._fetchSessionMeta SQL.
 *
 * The pre-fix version joined `user_proxies` (a non-existent table) on
 * `sessions.proxy_id` and selected `country` — which raised
 * `relation "user_proxies" does not exist` on every 10 s tick, silently
 * caught by the orchestrator's tick handler. This test pins the
 * correct schema references so future refactors don't regress them.
 *
 * No DB connection — we mock pool.query and assert the literal SQL.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '../../src/services/monitor/monitorOrchestrator.js'),
  'utf8'
);

(function correctTableNames() {
  // The orchestrator must reference `proxies` (not `user_proxies`).
  assert.ok(/LEFT JOIN proxies\s+p ON p\.id = s\.bound_proxy_id/i.test(src),
    'orchestrator must LEFT JOIN proxies ON p.id = s.bound_proxy_id');
  assert.ok(!/user_proxies/i.test(src),
    'orchestrator must NOT reference the non-existent user_proxies table');
  console.log('OK orchestrator joins `proxies` on `sessions.bound_proxy_id`');
})();

(function correctColumnNames() {
  // proxies.country_code is the column added in v14 — older
  // implementations selected `p.country` which never existed.
  assert.ok(/p\.country_code\s+AS proxy_country/i.test(src),
    'orchestrator must select p.country_code AS proxy_country');
  assert.ok(!/p\.country\b(?!_code)/i.test(src),
    'orchestrator must NOT select the non-existent p.country column');
  console.log('OK orchestrator selects `p.country_code AS proxy_country`');
})();

(function correctSessionFkColumn() {
  // Sessions store their bound proxy in `bound_proxy_id` (v3),
  // not `proxy_id` (which is the FK on the session_proxy_assignments
  // helper table, a different schema object).
  assert.ok(/s\.bound_proxy_id/i.test(src),
    'orchestrator must reference sessions.bound_proxy_id');
  // Plain "s.proxy_id" without bound_ prefix would be the regression.
  assert.ok(!/\bs\.proxy_id\b/i.test(src),
    'orchestrator must NOT reference the non-existent sessions.proxy_id column');
  console.log('OK orchestrator references `sessions.bound_proxy_id`');
})();

console.log('monitorOrchestratorSql.smoke.test: OK');
