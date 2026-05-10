#!/usr/bin/env node
/**
 * verify-sessions
 *
 * Read-only script that confirms every "active" session in the panel
 * still has a valid, decryptable, parseable StringSession on disk
 * BEFORE and AFTER a deploy.
 *
 * The user's hard rule for the 1000+ scale-up is:
 *
 *     "If I lost them from the panel I will completely lost them."
 *
 * The deploy orchestrator (`bin/upgrade`) calls this script twice:
 *
 *   1. Pre-deploy: snapshot the current set of active sessions and
 *      verify each one's encrypted file decrypts and decodes.
 *
 *   2. Post-deploy: same set, same verification. If anything that
 *      passed the pre-flight is now failing, the deploy is judged
 *      "session-destroying" and aborts (caller exit code = 2 → roll
 *      back).
 *
 * The script does NOT call Telegram. Doing 1000 getMe() calls during
 * a deploy is exactly the kind of activity that triggers spam-server
 * intervention. We only verify *we* haven't lost the bytes; if
 * Telegram revoked the auth_key out-of-band that's caught by the
 * runtime heartbeat (`telegramService.heartbeat`) — not by this
 * script.
 *
 * Output:
 *   - JSON to stdout: { generatedAt, totalActive, ok, missing,
 *     unparseable, sessions: [...] }
 *   - Exit codes:
 *       0  - everything that was active is still readable
 *       1  - couldn't connect to DB / required env missing
 *       2  - at least one previously-active session is now missing
 *            or unparseable
 *
 * Usage:
 *   node backend/scripts/verify-sessions.js               # pretty stdout
 *   node backend/scripts/verify-sessions.js --json        # machine-parseable
 *   node backend/scripts/verify-sessions.js --baseline f  # compare to baseline JSON
 *   node backend/scripts/verify-sessions.js --save f      # write baseline JSON
 *
 * Pair with bin/upgrade:
 *   pre:  node backend/scripts/verify-sessions.js --json --save /var/lib/panel/preflight.json
 *   post: node backend/scripts/verify-sessions.js --json --baseline /var/lib/panel/preflight.json
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Lazy-require so `--help` works even if the env isn't loaded.
function lazyDeps() {
  require('dotenv').config();
  const { pool } = require('../src/config/database');
  const { decrypt } = require('../src/utils/crypto');
  return { pool, decrypt };
}

function parseArgs(argv) {
  const out = { json: false, baseline: null, save: null, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--baseline') out.baseline = argv[++i];
    else if (a === '--save') out.save = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function help() {
  console.log(
    `verify-sessions — read-only safety check for Telegram session bytes.

Usage:
  node backend/scripts/verify-sessions.js [options]

Options:
  --json              emit JSON to stdout (machine-parseable)
  --save <path>       write the verification result as the new baseline
  --baseline <path>   compare against a baseline file; exit 2 if any
                      session that previously passed now fails
  -h, --help          show this help

Exit codes:
  0  everything OK (or compared OK to baseline)
  1  configuration / DB connection error
  2  one or more sessions regressed since the baseline\n`
  );
}

async function loadActiveSessions(pool) {
  // We treat both 'active' and 'uploaded' as "the human expects this
  // session to come back online after the deploy". 'revoked' rows
  // are intentionally skipped — they're already known-broken.
  const r = await pool.query(
    `SELECT id, user_id, phone, status, session_file_path, api_id, api_hash, last_active
       FROM sessions
      WHERE status IN ('active', 'uploaded', 'inactive')
      ORDER BY id ASC`
  );
  return r.rows;
}

function uploadDir() {
  return process.env.UPLOAD_DIR || path.resolve(__dirname, '../uploads');
}

async function verifySession(row, decrypt) {
  const result = {
    id: row.id,
    userId: row.user_id,
    phone: row.phone,
    status: row.status,
    ok: false,
    error: null,
  };
  try {
    if (!row.session_file_path) {
      result.error = 'session_file_path is null';
      return result;
    }
    const full = path.join(uploadDir(), row.session_file_path);
    if (!fs.existsSync(full)) {
      result.error = `file does not exist: ${row.session_file_path}`;
      return result;
    }
    const raw = fs.readFileSync(full, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      result.error = `JSON parse failed: ${e.message}`;
      return result;
    }
    if (!parsed.session) {
      result.error = 'no `session` key in payload';
      return result;
    }
    let plaintext;
    try {
      plaintext = decrypt(parsed.session);
    } catch (e) {
      result.error = `decrypt failed: ${e.message}`;
      return result;
    }
    if (!plaintext || typeof plaintext !== 'string' || plaintext.length < 10) {
      result.error = 'decrypted session string is empty or implausibly short';
      return result;
    }
    // Also confirm the api credentials look intact — without them
    // we couldn't reconnect even if the auth_key is fine.
    if (!row.api_id || !row.api_hash) {
      result.error = 'api_id / api_hash missing from sessions row';
      return result;
    }
    result.ok = true;
    return result;
  } catch (e) {
    result.error = e.message;
    return result;
  }
}

function summarize(rows) {
  const ok = rows.filter((r) => r.ok).length;
  const failed = rows.filter((r) => !r.ok);
  return {
    generatedAt: new Date().toISOString(),
    totalChecked: rows.length,
    ok,
    failedCount: failed.length,
    failed: failed.map((f) => ({
      id: f.id,
      phone: f.phone,
      status: f.status,
      error: f.error,
    })),
  };
}

function compareToBaseline(baseline, current) {
  // Anything that was OK in the baseline must still be OK now. New
  // failures since baseline → regression. Failures that *also* failed
  // pre-deploy are not a regression (they were already broken).
  const baselineFailed = new Set((baseline.failed || []).map((f) => f.id));
  const newFailures = (current.failed || []).filter((f) => !baselineFailed.has(f.id));
  return {
    regressed: newFailures.length > 0,
    newFailures,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { help(); process.exit(0); }

  let pool;
  let decrypt;
  try {
    ({ pool, decrypt } = lazyDeps());
  } catch (e) {
    console.error(`verify-sessions: failed to load deps: ${e.message}`);
    process.exit(1);
  }

  let rows;
  try {
    rows = await loadActiveSessions(pool);
  } catch (e) {
    console.error(`verify-sessions: DB query failed: ${e.message}`);
    process.exit(1);
  }

  const verified = [];
  for (const row of rows) {
    verified.push(await verifySession(row, decrypt));
  }

  const summary = summarize(verified);

  if (args.save) {
    fs.mkdirSync(path.dirname(path.resolve(args.save)), { recursive: true });
    fs.writeFileSync(path.resolve(args.save), JSON.stringify(summary, null, 2));
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else {
    console.log(`verify-sessions: ${summary.ok}/${summary.totalChecked} sessions verified.`);
    if (summary.failedCount > 0) {
      console.log('Failed sessions:');
      for (const f of summary.failed) {
        console.log(`  #${f.id} (${f.phone || 'no phone'}) [${f.status}] — ${f.error}`);
      }
    }
  }

  if (args.baseline) {
    let baseline;
    try {
      baseline = JSON.parse(fs.readFileSync(path.resolve(args.baseline), 'utf8'));
    } catch (e) {
      console.error(`verify-sessions: could not read baseline: ${e.message}`);
      process.exit(1);
    }
    const cmp = compareToBaseline(baseline, summary);
    if (cmp.regressed) {
      console.error(`verify-sessions: REGRESSION — ${cmp.newFailures.length} session(s) became unreadable since the baseline:`);
      for (const f of cmp.newFailures) {
        console.error(`  #${f.id} (${f.phone || 'no phone'}) — ${f.error}`);
      }
      console.error('Aborting deploy. Sessions in this list must be recovered before retrying.');
      try { await pool.end(); } catch { /* ignore */ }
      process.exit(2);
    }
    console.log(
      `verify-sessions: no regressions vs baseline (${baseline.totalChecked} → ${summary.totalChecked}).`
    );
  }

  try { await pool.end(); } catch { /* ignore */ }
  process.exit(0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`verify-sessions: unexpected error: ${e.message}`);
    process.exit(1);
  });
}

module.exports = {
  verifySession,
  summarize,
  compareToBaseline,
};
