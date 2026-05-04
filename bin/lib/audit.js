/**
 * Audit log for the upgrade orchestrator.
 *
 * Two destinations:
 *   1. `logs/upgrade-audit.log` — append-only file on the host, survives
 *      container restarts (it lives in the bind-mounted logs/ dir).
 *   2. `deployments` table in Postgres — durable, query-able, used by the
 *      Telegram /status command and `bin/upgrade rollback`.
 *
 * Both writes are best-effort; the orchestrator MUST NOT crash if Postgres
 * is briefly unreachable during an audit write (the deploy itself is what
 * matters; audit is observability).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');

// `pg` is optional at the orchestrator level. When the operator runs
// `bin/upgrade` from the host, pg is normally NOT installed (the host has
// no node_modules — the backend node_modules lives inside the image). We
// fall back to running psql inside the postgres container, which is always
// reachable when the stack is up. The pool path is still used inside the
// admin-bot container which has pg installed.
function tryRequirePg() {
  const candidates = [
    path.join(REPO_ROOT, 'backend', 'node_modules', 'pg'),
    'pg',
  ];
  for (const c of candidates) {
    try { return require(c); } catch (_) { /* keep trying */ }
  }
  return null;
}
const pg = tryRequirePg();

const LOG_DIR = process.env.UPGRADE_LOG_DIR
  || path.join(__dirname, '..', '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'upgrade-audit.log');

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function appendFileLine(obj) {
  ensureLogDir();
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n';
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (err) {
    process.stderr.write(`audit: failed to append ${LOG_FILE}: ${err.message}\n`);
  }
}

// `bin/upgrade` runs on the HOST (not inside a container), but the project's
// .env files describe in-container hostnames (DB_HOST=postgres, DB_PORT=5435).
// Postgres is published to the host via docker-compose `ports:` mapping —
// the *published* port is unrelated to the *internal* port and varies by
// project (e.g. `5439:5435`). We auto-detect the published port via
// `docker compose port postgres <internal>`. Inside the admin-bot container
// `/.dockerenv` exists, DB_HOST=postgres resolves, and we use DB_PORT as-is.
function isInsideContainer() {
  try { return fs.existsSync('/.dockerenv'); } catch (_) { return false; }
}

let cachedHostPgPort = null;
function detectHostPgPort() {
  if (cachedHostPgPort) return cachedHostPgPort;
  try {
    const internal = parseInt(process.env.DB_PORT || '5435', 10);
    const r = require('child_process').spawnSync(
      'docker',
      ['compose', 'port', 'postgres', String(internal)],
      {
        encoding: 'utf8',
        cwd: path.join(__dirname, '..', '..'),
        timeout: 3000,
      }
    );
    if (r.status === 0 && r.stdout) {
      const m = r.stdout.match(/:(\d+)\s*$/m);
      if (m) {
        cachedHostPgPort = parseInt(m[1], 10);
        return cachedHostPgPort;
      }
    }
  } catch (_) { /* fall through */ }
  return null;
}

function pgEnv() {
  const inContainer = isInsideContainer();
  let host;
  let port;
  if (inContainer) {
    host = process.env.DB_HOST || 'localhost';
    port = parseInt(process.env.DB_PORT || '5435', 10);
  } else {
    // On the host we ignore DB_HOST (it's almost always "postgres", a docker
    // service name that doesn't resolve). Operators can pin a custom value
    // via UPGRADE_DB_HOST / UPGRADE_DB_PORT for non-default setups.
    host = process.env.UPGRADE_DB_HOST || '127.0.0.1';
    port = parseInt(process.env.UPGRADE_DB_PORT || '0', 10) || detectHostPgPort();
  }
  return {
    host,
    port,
    database: process.env.DB_NAME || 'telegram_panel',
    user: process.env.DB_USER || 'postgres',
    // Honour DB_PASSWORD first (used by the backend container), fall back to
    // POSTGRES_PASSWORD which is what root .env names it for compose. Without
    // this fallback the audit pool silently fails from the host CLI because
    // root .env doesn't define DB_PASSWORD.
    password:
      process.env.DB_PASSWORD ||
      process.env.POSTGRES_PASSWORD ||
      'your_secure_password',
  };
}

function makePool() {
  if (!pg) return null;
  const cfg = pgEnv();
  // If host-port detection failed (Postgres not running, no compose stack),
  // skip the DB write entirely. The file audit log still captures the event.
  if (!cfg.port) return null;
  return new pg.Pool({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    max: 2,
    connectionTimeoutMillis: parseInt(process.env.DB_POOL_CONNECT_MS || '10000', 10),
  });
}

// ---------------------------------------------------------------------------
// psql-via-docker fallback. Used when `pg` isn't installed (host CLI on a
// VPS) AND the postgres container is running. Returns row-arrays parsed from
// psql's `-tAF\t` (tab-separated, no headers) output.
// ---------------------------------------------------------------------------

function quoteSqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  // Treat everything else as text. Standard SQL string escaping: double the
  // single quotes. We're invoking psql on trusted, locally-generated values
  // (timestamps, SHAs, color names, JSON metadata) so this is safe.
  return "'" + String(v).replace(/'/g, "''") + "'";
}

// Replace $1, $2, ... placeholders with quoted literals. $$ is preserved so
// dollar-quoted strings (rare in our SQL) still work.
function inlineParams(sql, params) {
  return sql.replace(/\$(\d+)/g, (_, n) => {
    const idx = parseInt(n, 10) - 1;
    if (idx < 0 || idx >= params.length) return '$' + n;
    return quoteSqlLiteral(params[idx]);
  });
}

function psqlAvailable() {
  try {
    const r = spawnSync('docker', ['compose', 'ps', '-q', 'postgres'], {
      encoding: 'utf8', cwd: REPO_ROOT, timeout: 3000,
    });
    return r.status === 0 && r.stdout && r.stdout.trim().length > 0;
  } catch (_) {
    return false;
  }
}

function runPsqlSync(sql, params = []) {
  const inlined = inlineParams(sql, params);
  const dbName = process.env.DB_NAME || 'telegram_panel';
  const dbUser = process.env.DB_USER || 'postgres';
  const args = [
    'compose', 'exec', '-T', 'postgres',
    'psql', '-U', dbUser, '-d', dbName,
    '-tAF', '\t', '-X', '-q', '-v', 'ON_ERROR_STOP=1',
    '-c', inlined,
  ];
  const r = spawnSync('docker', args, {
    encoding: 'utf8', cwd: REPO_ROOT, timeout: 10000,
  });
  if (r.status !== 0) {
    const err = new Error(
      `psql failed (exit ${r.status}): ${(r.stderr || '').trim()}`
    );
    err.stderr = r.stderr;
    throw err;
  }
  // -tA -F\t: rows separated by \n, columns separated by \t. Trim trailing
  // newline.
  const out = (r.stdout || '').replace(/\n+$/, '');
  if (out === '') return [];
  return out.split('\n').map((line) => line.split('\t'));
}

async function dbQuery(sql, params = []) {
  const pool = makePool();
  if (pool) {
    try {
      const result = await pool.query(sql, params);
      return { rows: result.rows };
    } catch (err) {
      throw err;
    } finally {
      await pool.end().catch(() => {});
    }
  }
  // No pg module → use psql via docker.
  if (!psqlAvailable()) {
    throw new Error('audit: postgres container not running and no pg module available');
  }
  const rowArrays = runPsqlSync(sql, params);
  // Caller expects rows[i] to be an object keyed by column name, but psql -tA
  // gives positional values. We reconstruct field names by parsing column
  // aliases out of the SELECT or RETURNING clause.
  const fieldNames = extractFieldNames(sql);
  const rows = rowArrays.map((cells) => {
    if (!fieldNames) return cells;
    const obj = {};
    for (let i = 0; i < fieldNames.length; i++) {
      let v = cells[i];
      if (v === '') v = null;
      obj[fieldNames[i]] = v;
    }
    return obj;
  });
  return { rows };
}

function extractFieldNames(sql) {
  // Best-effort: find the column list of the topmost SELECT or RETURNING
  // clause. Stops at FROM / WHERE / ; or end-of-string. Handles parenthesised
  // expressions but NOT nested subqueries — that's fine for our static SQL.
  const m = sql.match(/(?:^|\s)(?:SELECT|RETURNING)\s+([\s\S]+?)(?:\s+FROM\s|\s+WHERE\s|\s*;|$)/i);
  if (!m) return null;
  const list = m[1].trim();
  if (list === '*') return null;
  // Split on commas at depth 0.
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => {
    p = p.trim();
    const asMatch = p.match(/\s+AS\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?$/i);
    if (asMatch) return asMatch[1];
    // Fallback: last identifier in the expression.
    const idMatch = p.match(/([a-zA-Z_][a-zA-Z0-9_]*)\s*$/);
    return idMatch ? idMatch[1] : p;
  });
}

/**
 * Insert a row in `deployments` and return its id, OR return null if the
 * insert failed (DB unreachable, schema not migrated yet).
 */
async function startDeployment({ initiatedBy, targetRef, prevSha, color }) {
  try {
    const { rows } = await dbQuery(
      `INSERT INTO deployments
         (initiated_by, target_ref, prev_sha, color_promoted, status, metadata)
       VALUES ($1, $2, $3, $4, 'pending', '{}'::jsonb)
       RETURNING id`,
      [initiatedBy, targetRef || null, prevSha || null, color || null]
    );
    if (!rows[0]) return null;
    const idVal = rows[0].id;
    return idVal == null ? null : Number(idVal);
  } catch (err) {
    process.stderr.write(`audit: deployments INSERT failed: ${err.message}\n`);
    return null;
  }
}

async function finishDeployment(id, patch) {
  if (!id) return;
  try {
    await dbQuery(
      `UPDATE deployments
         SET finished_at  = COALESCE($2, NOW()),
             status       = COALESCE($3, status),
             target_sha   = COALESCE($4, target_sha),
             health_ms    = COALESCE($5, health_ms),
             total_ms     = COALESCE($6, total_ms),
             error_message= COALESCE($7, error_message),
             metadata     = COALESCE(metadata, '{}'::jsonb) || COALESCE($8::jsonb, '{}'::jsonb)
       WHERE id = $1`,
      [
        id,
        patch.finishedAt || null,
        patch.status || null,
        patch.targetSha || null,
        patch.healthMs == null ? null : Number(patch.healthMs),
        patch.totalMs == null ? null : Number(patch.totalMs),
        patch.errorMessage || null,
        patch.metadata ? JSON.stringify(patch.metadata) : null,
      ]
    );
  } catch (err) {
    process.stderr.write(`audit: deployments UPDATE failed: ${err.message}\n`);
  }
}

async function recentDeployments(limit = 10) {
  try {
    const { rows } = await dbQuery(
      `SELECT id, started_at, finished_at, initiated_by, target_ref,
              target_sha, prev_sha, color_promoted, status, total_ms,
              error_message
         FROM deployments
        ORDER BY id DESC
        LIMIT $1`,
      [Number(limit)]
    );
    return rows;
  } catch (_) {
    return [];
  }
}

async function lastSuccessfulSha() {
  try {
    const { rows } = await dbQuery(
      `SELECT target_sha
         FROM deployments
        WHERE status = 'healthy'
          AND target_sha IS NOT NULL
        ORDER BY id DESC
        LIMIT 1 OFFSET 1`
    );
    return rows[0] ? rows[0].target_sha : null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  appendFileLine,
  startDeployment,
  finishDeployment,
  recentDeployments,
  lastSuccessfulSha,
  LOG_FILE,
};
