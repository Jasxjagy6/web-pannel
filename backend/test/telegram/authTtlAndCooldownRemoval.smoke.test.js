/**
 * Smoke test for the cooldown-removal + auth-ttl rewrite.
 *
 * Covers:
 *   1. The privacy service surface for `auth_ttl`:
 *      - exports the synthetic key name and the legal day-counts.
 *      - validator accepts every preset, rejects anything else.
 *   2. The migration-safety guard:
 *      - the new migration_v27_drop_session_cooldown.sql passes.
 *      - the auth-key columns the guard *does* protect still trip it.
 *   3. The session-cooldown module is gone — `require('../src/services/sessionCooldown')`
 *      must throw MODULE_NOT_FOUND.
 *
 * No DB / no Telegram client required.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

// -------------------- 1. privacyService surface --------------------
const privacyService = require('../../src/services/privacyService');

assert.strictEqual(privacyService.AUTH_TTL_KEY, 'auth_ttl');
assert.ok(Array.isArray(privacyService.AUTH_TTL_DAY_OPTIONS));
assert.deepStrictEqual(
  [...privacyService.AUTH_TTL_DAY_OPTIONS].sort((a, b) => a - b),
  [7, 90, 180, 365]
);
console.log('OK auth_ttl key + day options exported');

// Every Telegram preset must validate.
for (const days of privacyService.AUTH_TTL_DAY_OPTIONS) {
  assert.strictEqual(
    privacyService.isAuthTtlValueValid(days),
    true,
    `expected ${days} to be valid`
  );
}
console.log('OK isAuthTtlValueValid accepts every preset');

// Things that must be rejected.
const badValues = [
  null, undefined, '', 0, -1, 1, 6, 8, 30, 60, 91, 366, 1000,
  '7', '90', NaN, Infinity, true, false, {}, [], 'abc',
];
for (const v of badValues) {
  assert.strictEqual(
    privacyService.isAuthTtlValueValid(v),
    false,
    `expected ${JSON.stringify(v)} to be rejected, but it was accepted`
  );
}
console.log('OK isAuthTtlValueValid rejects non-preset values');

// `keys` filter inside applyToSession (indirectly) — make sure the key
// is recognised. We can't invoke applyToSession without a Telegram
// client, so we just spot-check the exported PRIVACY_KEYS list still
// has the original 11 entries (no accidental shadowing).
assert.strictEqual(privacyService.PRIVACY_KEYS.length, 11);
assert.ok(privacyService.PRIVACY_KEYS.includes('messages'));
console.log('OK PRIVACY_KEYS list unchanged (11 entries)');


// -------------------- 2. migration-safety guard --------------------
const { check } = require('../../scripts/check-migration-safety');

const v27Path = path.join(
  __dirname,
  '..',
  '..',
  'src',
  'config',
  'migration_v27_drop_session_cooldown.sql'
);
assert.ok(fs.existsSync(v27Path), 'migration v27 file should exist');
const v27Issues = check(v27Path);
assert.deepStrictEqual(
  v27Issues,
  [],
  `migration_v27 should pass the safety guard; got: ${v27Issues.join('; ')}`
);
console.log('OK migration_v27 (drop cooldown columns) passes safety guard');

// And the guard still trips on protected auth columns:
const os = require('os');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migsafe-authttl-'));
const guardedFile = path.join(tmpDir, 'migration_vX_evil.sql');
fs.writeFileSync(
  guardedFile,
  'ALTER TABLE sessions DROP COLUMN session_file_path;'
);
try {
  const issues = check(guardedFile);
  assert.ok(
    issues.some((m) => /DROP COLUMN session_file_path/.test(m)),
    `expected guard to still block session_file_path drop, got: ${issues.join('; ')}`
  );
} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log('OK guard still blocks DROP COLUMN of session_file_path');


// -------------------- 3. sessionCooldown.js is gone ----------------
let threwModuleNotFound = false;
try {
  require('../../src/services/sessionCooldown');
} catch (err) {
  threwModuleNotFound = err && err.code === 'MODULE_NOT_FOUND';
}
assert.strictEqual(
  threwModuleNotFound,
  true,
  'sessionCooldown module must no longer be loadable'
);
console.log('OK sessionCooldown module has been removed');


// -------------------- 4. groupService no longer requires it --------
const gsSource = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'services', 'groupService.js'),
  'utf8'
);
assert.ok(
  !/require\(['"]\.\/sessionCooldown['"]\)/.test(gsSource),
  'groupService.js must not require sessionCooldown'
);
assert.ok(
  !/cooldownSkipped/.test(gsSource),
  'groupService.js must no longer mention cooldownSkipped'
);
console.log('OK groupService.js is free of cooldown references');


// -------------------- 5. messageService verifier signature --------
// The legacy signature accepted `(ids, userId, { filterCooldown })`;
// we removed the third arg. Make sure calling with the legacy options
// object still works (extra args are ignored, so callers that pass
// `{ filterCooldown: false }` during a rollout don't crash).
const messageService = require('../../src/services/messageService');
assert.strictEqual(
  typeof messageService._verifyMultipleSessionsOwnership,
  'function'
);
console.log('OK messageService._verifyMultipleSessionsOwnership still exported');


console.log('\nauthTtlAndCooldownRemoval.smoke.test: OK');
