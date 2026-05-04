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

// `pg` is optional at the orchestrator level. When the operator runs
// `bin/upgrade` from the host, pg is normally found in backend/node_modules;
// when it's missing (e.g. fresh checkout, no `npm install` yet), we just
// skip the database audit log and rely on the file log. The deploy itself
// still works — audit is observability, not correctness.
function tryRequirePg() {
  const candidates = [
    path.join(__dirname, '..', '..', 'backend', 'node_modules', 'pg'),
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

function makePool() {
  if (!pg) return null;
  return new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5435', 10),
    database: process.env.DB_NAME || 'telegram_panel',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'your_secure_password',
    max: 2,
    connectionTimeoutMillis: parseInt(process.env.DB_POOL_CONNECT_MS || '10000', 10),
  });
}

/**
 * Insert a row in `deployments` and return its id, OR return null if the
 * insert failed (DB unreachable, schema not migrated yet).
 */
async function startDeployment({ initiatedBy, targetRef, prevSha, color }) {
  const pool = makePool();
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO deployments
         (initiated_by, target_ref, prev_sha, color_promoted, status, metadata)
       VALUES ($1, $2, $3, $4, 'pending', '{}'::jsonb)
       RETURNING id`,
      [initiatedBy, targetRef || null, prevSha || null, color || null]
    );
    return rows[0] && rows[0].id;
  } catch (err) {
    process.stderr.write(`audit: deployments INSERT failed: ${err.message}\n`);
    return null;
  } finally {
    await pool.end().catch(() => {});
  }
}

async function finishDeployment(id, patch) {
  if (!id) return;
  const pool = makePool();
  if (!pool) return;
  try {
    await pool.query(
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
  } finally {
    await pool.end().catch(() => {});
  }
}

async function recentDeployments(limit = 10) {
  const pool = makePool();
  if (!pool) return [];
  try {
    const { rows } = await pool.query(
      `SELECT id, started_at, finished_at, initiated_by, target_ref,
              target_sha, prev_sha, color_promoted, status, total_ms,
              error_message
         FROM deployments
        ORDER BY id DESC
        LIMIT $1`,
      [limit]
    );
    return rows;
  } catch (err) {
    return [];
  } finally {
    await pool.end().catch(() => {});
  }
}

async function lastSuccessfulSha() {
  const pool = makePool();
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
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
  } finally {
    await pool.end().catch(() => {});
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
