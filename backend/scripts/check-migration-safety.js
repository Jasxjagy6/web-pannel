#!/usr/bin/env node
/**
 * check-migration-safety
 *
 * Lint script that runs in CI / pre-commit to refuse any database
 * migration that destroys the columns Telegram session auth depends
 * on.
 *
 * Background: the panel stores each session's encrypted MTProto
 * `auth_key` (StringSession bytes) on disk under `session_file_path`
 * and metadata in the `sessions` table. If a migration ever DROPs
 * one of these columns, ALTERs its type, or rewrites its content,
 * every session in the panel is lost — Telegram won't let us
 * regenerate auth_keys, the human has to re-upload every account.
 *
 * The user explicitly said: "if I lost them from pannel I will
 * completely lost them". So we hard-fail any PR that:
 *
 *   * DROPs / RENAMEs / ALTERs the type of any of:
 *       sessions.session_file_path
 *       sessions.api_id
 *       sessions.api_hash
 *       sessions.phone
 *       sessions.account_info
 *       sessions.session_string
 *       sessions.session_data
 *       session_backups.backup_path
 *       session_backups.content_sha256
 *
 *   * UPDATEs sessions.session_file_path / session_string /
 *     session_data anywhere in the migration body.
 *
 *   * DELETEs from `sessions` or `session_backups`.
 *
 * Adding new columns / new tables / new indexes is always allowed.
 * The intent is "additive only" for these tables.
 *
 * Usage:
 *   node backend/scripts/check-migration-safety.js
 *     -> exits 0 if ok, 1 if any forbidden statement found
 *
 *   node backend/scripts/check-migration-safety.js path/to/file.sql
 *     -> check just one file
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PROTECTED_COLUMNS = [
  // (table, column)
  ['sessions', 'session_file_path'],
  ['sessions', 'api_id'],
  ['sessions', 'api_hash'],
  ['sessions', 'phone'],
  ['sessions', 'account_info'],
  ['sessions', 'session_string'],
  ['sessions', 'session_data'],
  ['session_backups', 'backup_path'],
  ['session_backups', 'content_sha256'],
];

const PROTECTED_TABLES = ['sessions', 'session_backups'];

function findMigrationFiles(target) {
  if (target) {
    return [path.resolve(target)];
  }
  const dir = path.resolve(__dirname, '../src/config');
  return fs
    .readdirSync(dir)
    .filter((f) => /^migration_.*\.sql$/i.test(f))
    .map((f) => path.join(dir, f));
}

/**
 * Strip SQL comments so they don't trigger false positives — e.g.
 * "-- DROP COLUMN session_string" inside a comment must not flag.
 *
 * Strips both `-- line` comments and `/* block * /` comments while
 * preserving line numbers (so the error message points at the right
 * line).
 */
function stripComments(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') {
        out += sql[i] === '\n' ? '\n' : ' ';
        i++;
      }
    } else if (sql[i] === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        out += sql[i] === '\n' ? '\n' : ' ';
        i++;
      }
      i += 2;
    } else {
      out += sql[i];
      i++;
    }
  }
  return out;
}

function check(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const sql = stripComments(raw);
  const issues = [];

  // Match statements like `ALTER TABLE sessions DROP COLUMN ...`.
  // Anchored to PROTECTED_TABLES so unrelated migrations can't trigger.
  for (const t of PROTECTED_TABLES) {
    // 1. ALTER TABLE <t> DROP COLUMN  → forbidden.
    const dropColRe = new RegExp(
      String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?\b${t}\b[\s\S]*?\bDROP\s+COLUMN\b\s+(?:IF\s+EXISTS\s+)?["']?(\w+)`,
      'gi'
    );
    let m;
    while ((m = dropColRe.exec(sql))) {
      issues.push(
        `forbidden: ALTER TABLE ${t} DROP COLUMN ${m[1]} — destroys session auth state`
      );
    }
    // 2. ALTER TABLE <t> RENAME COLUMN <protected> ...
    for (const [pt, pc] of PROTECTED_COLUMNS) {
      if (pt !== t) continue;
      const renameRe = new RegExp(
        String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?\b${t}\b[\s\S]*?\bRENAME\s+COLUMN\b\s+["']?${pc}["']?`,
        'gi'
      );
      if (renameRe.test(sql)) {
        issues.push(
          `forbidden: ALTER TABLE ${t} RENAME COLUMN ${pc} — breaks every session loader`
        );
      }
      // 3. ALTER TABLE <t> ALTER COLUMN <protected> TYPE ...
      const alterTypeRe = new RegExp(
        String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?\b${t}\b[\s\S]*?\bALTER\s+COLUMN\b\s+["']?${pc}["']?[\s\S]*?\bTYPE\b`,
        'gi'
      );
      if (alterTypeRe.test(sql)) {
        issues.push(
          `forbidden: ALTER TABLE ${t} ALTER COLUMN ${pc} TYPE — would corrupt session bytes`
        );
      }
    }
    // 4. DROP TABLE <protected>
    const dropTableRe = new RegExp(
      String.raw`DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?\b${t}\b`,
      'gi'
    );
    if (dropTableRe.test(sql)) {
      issues.push(`forbidden: DROP TABLE ${t} — wipes every session in the panel`);
    }
    // 5. TRUNCATE <protected>
    const truncRe = new RegExp(
      String.raw`TRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?\b${t}\b`,
      'gi'
    );
    if (truncRe.test(sql)) {
      issues.push(`forbidden: TRUNCATE ${t} — wipes every session in the panel`);
    }
    // 6. DELETE from sessions / session_backups (without explicit WHERE
    //    that scopes by `id`/`session_id` — even then we'd rather call
    //    it out so the human re-confirms).
    const deleteRe = new RegExp(String.raw`DELETE\s+FROM\s+\b${t}\b`, 'gi');
    if (deleteRe.test(sql)) {
      issues.push(
        `forbidden: DELETE FROM ${t} — migrations should never delete session rows; do it from a runtime ops endpoint with audit logging instead`
      );
    }
    // 7. UPDATE sessions / session_backups SET <protected> = ...
    for (const [pt, pc] of PROTECTED_COLUMNS) {
      if (pt !== t) continue;
      const updateRe = new RegExp(
        String.raw`UPDATE\s+\b${t}\b[\s\S]*?\bSET\b[\s\S]*?\b${pc}\b\s*=`,
        'gi'
      );
      if (updateRe.test(sql)) {
        issues.push(
          `forbidden: UPDATE ${t} SET ${pc} = ... — overwriting session bytes from a migration is irreversible`
        );
      }
    }
  }

  return issues;
}

function main() {
  const target = process.argv[2];
  const files = findMigrationFiles(target);
  if (files.length === 0) {
    console.log('check-migration-safety: no migration files found');
    process.exit(0);
  }
  let total = 0;
  for (const f of files) {
    const issues = check(f);
    if (issues.length) {
      total += issues.length;
      console.error(`\n[FAIL] ${path.basename(f)}`);
      for (const i of issues) console.error(`  - ${i}`);
    }
  }
  if (total > 0) {
    console.error(
      `\ncheck-migration-safety: ${total} forbidden statement(s) found across ${files.length} file(s).`
    );
    console.error(
      'Migrations to the sessions / session_backups tables must be additive only.'
    );
    process.exit(1);
  }
  console.log(`check-migration-safety: ${files.length} file(s) clean.`);
  process.exit(0);
}

if (require.main === module) main();

module.exports = { check, stripComments, PROTECTED_COLUMNS, PROTECTED_TABLES };
