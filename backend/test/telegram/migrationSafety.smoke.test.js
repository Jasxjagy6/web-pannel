/**
 * Smoke test for backend/scripts/check-migration-safety.js
 *
 * The script must:
 *   - Pass clean migrations that ADD columns / indexes / tables.
 *   - Reject DROP / RENAME / ALTER TYPE on any protected column.
 *   - Reject DROP / TRUNCATE / DELETE from sessions / session_backups.
 *   - Reject UPDATEs to protected session-bytes columns.
 *   - Ignore destructive-looking SQL inside SQL comments.
 *
 * We test by feeding small inline SQL strings to the exported
 * `check(filePath)` function via temporary files — no DB needed.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { check, stripComments } = require('../../scripts/check-migration-safety');

function withTempSql(sql, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migsafe-'));
  const file = path.join(dir, 'migration_v_test.sql');
  fs.writeFileSync(file, sql);
  try {
    return fn(file);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function expectOk(sql) {
  withTempSql(sql, (f) => {
    const issues = check(f);
    assert.deepStrictEqual(issues, [], `expected clean: ${sql.slice(0, 60)}…`);
  });
}

function expectBad(sql, matcher) {
  withTempSql(sql, (f) => {
    const issues = check(f);
    assert.ok(issues.length > 0, `expected violations for: ${sql.slice(0, 60)}…`);
    if (matcher) {
      assert.ok(
        issues.some((i) => matcher.test(i)),
        `expected at least one issue matching ${matcher}, got: ${issues.join('; ')}`
      );
    }
  });
}

// -------- clean cases --------
expectOk(`-- routine additive migration
CREATE TABLE IF NOT EXISTS feature_flags (id SERIAL, key TEXT);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS feature_x TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_feature_x ON sessions(feature_x);
`);
console.log('OK additive migration accepted');

expectOk(`-- comments mentioning DROP COLUMN session_string must NOT trigger
-- DROP COLUMN session_string -- this is an explanation, not a statement
ALTER TABLE sessions ADD COLUMN deferred_at TIMESTAMP;`);
console.log('OK comments do not false-positive');

expectOk(`/* block comment describing DROP TABLE sessions */
ALTER TABLE sessions ADD COLUMN status_v2 VARCHAR;`);
console.log('OK block comments do not false-positive');

// -------- bad cases --------
expectBad(
  `ALTER TABLE sessions DROP COLUMN session_file_path;`,
  /DROP COLUMN session_file_path/
);
console.log('OK rejects DROP COLUMN session_file_path');

expectBad(
  `ALTER TABLE IF EXISTS sessions DROP COLUMN IF EXISTS api_id;`,
  /DROP COLUMN api_id/
);
console.log('OK rejects DROP COLUMN with IF EXISTS guards');

expectBad(
  `ALTER TABLE sessions RENAME COLUMN session_file_path TO old_path;`,
  /RENAME COLUMN session_file_path/
);
console.log('OK rejects RENAME of protected column');

expectBad(
  `ALTER TABLE sessions ALTER COLUMN session_file_path TYPE BYTEA USING session_file_path::bytea;`,
  /ALTER COLUMN session_file_path TYPE/
);
console.log('OK rejects ALTER COLUMN TYPE on protected column');

expectBad(
  `DROP TABLE sessions;`,
  /DROP TABLE sessions/
);
console.log('OK rejects DROP TABLE sessions');

expectBad(
  `DROP TABLE IF EXISTS session_backups;`,
  /DROP TABLE session_backups/
);
console.log('OK rejects DROP TABLE session_backups');

expectBad(
  `TRUNCATE sessions;`,
  /TRUNCATE sessions/
);
console.log('OK rejects TRUNCATE sessions');

expectBad(
  `TRUNCATE TABLE ONLY session_backups;`,
  /TRUNCATE session_backups/
);
console.log('OK rejects TRUNCATE TABLE ONLY session_backups');

expectBad(
  `DELETE FROM sessions WHERE status = 'inactive';`,
  /DELETE FROM sessions/
);
console.log('OK rejects DELETE FROM sessions');

expectBad(
  `UPDATE sessions SET session_file_path = 'reset' WHERE id = 7;`,
  /UPDATE sessions SET session_file_path/
);
console.log('OK rejects UPDATE on protected column');

// stripComments preserves line numbers
const stripped = stripComments(`A
-- B
C
/* multi
line */
D`);
assert.strictEqual(stripped.split('\n').length, 6, 'stripComments keeps line count');
console.log('OK stripComments preserves line numbers');

console.log('\nmigrationSafety.smoke.test: OK');
