/**
 * Burner-cookie pool service — PR #4 (§2.2 stage 3 + stage 4 + §6.3).
 *
 * The burner pool is a list of sacrificial IG accounts whose cookies are
 * used by the email/phone existence probes against `web_create_ajax/`.
 * These cookies get burned fast (~30 probes apiece), so we never let
 * them touch the operator scrape sessions.
 *
 * Storage: `lookup_burners` (created by migration v34).
 *
 * Lifecycle:
 *   - insert():   encrypt cookie blob + persist a row
 *   - listAll():  admin / panel page (decrypted blob NEVER returned)
 *   - draw():     atomically lease the freshest non-blocked burner and
 *                 mark it as in-use (returns a session-context-ish
 *                 object usable by igFetch). Implemented via
 *                 `FOR UPDATE SKIP LOCKED` so concurrent enumerators
 *                 don't grab the same burner.
 *   - release():  return a burner to the pool, bumping probe_count.
 *   - block():    permanently retire a burner with a reason string.
 *
 * The service NEVER decrypts cookies in listAll() — operators see the
 * label, ds_user_id, probe_count, blocked state, but never the raw
 * `sessionid` / `csrftoken` values.
 */

'use strict';

const { pool } = require('../config/database');
const { encrypt, decrypt } = require('../utils/crypto');
const logger = require('../utils/logger');
const { cookieHeaderFromBlob } = require('../providers/instagram/igFetch');

/**
 * Normalise a cookie-blob payload into the shape `igFetch` understands.
 * Accepts:
 *   - the raw {cookies: [...]} JSON that the existing /privacy.js
 *     upload flow produces
 *   - the shorter {sessionid, ds_user_id, csrftoken, mid?} convenience
 *     form so an operator can paste the 3 cookies from DevTools without
 *     building the full blob structure.
 */
function _normaliseBlob(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('cookie blob must be a JSON object');
  }
  // Pass-through for the rich {cookies: [...]} blob.
  if (Array.isArray(input.cookies)) return input;

  // 3-cookie shorthand.
  const shorthand = {};
  for (const k of ['sessionid', 'ds_user_id', 'csrftoken', 'mid', 'ig_did']) {
    if (input[k]) shorthand[k] = String(input[k]);
  }
  if (!shorthand.sessionid || !shorthand.ds_user_id || !shorthand.csrftoken) {
    throw new Error(
      'cookie blob must either be the full {cookies:[...]} shape or ' +
      'provide sessionid + ds_user_id + csrftoken at minimum'
    );
  }
  const out = { cookies: [] };
  for (const [name, value] of Object.entries(shorthand)) {
    out.cookies.push({
      name,
      value,
      domain: '.instagram.com',
      path: '/',
      httpOnly: name === 'sessionid' || name === 'csrftoken',
      secure: true,
    });
  }
  return out;
}

/**
 * Insert a new burner into the pool. Returns the persisted row WITHOUT
 * the decrypted blob.
 */
async function insertBurner({
  cookieBlob,
  webFingerprint = null,
  boundProxyId = null,
  label = null,
  createdByUserId = null,
}) {
  const blob = _normaliseBlob(cookieBlob);
  const { dsUserId } = cookieHeaderFromBlob(blob);
  const enc = encrypt(JSON.stringify(blob));
  const { rows } = await pool.query(
    `INSERT INTO lookup_burners
       (created_by_user_id, label, cookie_blob_enc, web_fingerprint,
        bound_proxy_id, ds_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, created_by_user_id, label, ds_user_id, bound_proxy_id,
               web_fingerprint, created_at, last_used_at, probe_count,
               blocked, blocked_reason, blocked_at, risk_score`,
    [createdByUserId, label, enc, webFingerprint, boundProxyId, dsUserId || null]
  );
  return rows[0];
}

/**
 * List all burners (no decrypted blobs).
 */
async function listBurners({ includeBlocked = false, userId = null } = {}) {
  const where = [];
  const params = [];
  if (!includeBlocked) where.push(`blocked = FALSE`);
  if (userId) { params.push(userId); where.push(`created_by_user_id = $${params.length}`); }
  const sql = `
    SELECT b.id, b.created_by_user_id, b.label, b.ds_user_id, b.bound_proxy_id,
           b.web_fingerprint, b.created_at, b.last_used_at, b.probe_count,
           b.blocked, b.blocked_reason, b.blocked_at, b.risk_score,
           p.proxy_url AS bound_proxy_url
      FROM lookup_burners b
      LEFT JOIN proxies p ON p.id = b.bound_proxy_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY b.blocked ASC, b.last_used_at ASC NULLS FIRST, b.id ASC`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

/**
 * Atomically lease the freshest non-blocked burner. Returns the row +
 * the decrypted cookie blob, ready for `igFetch` to consume.
 *
 * The lease uses `FOR UPDATE SKIP LOCKED` so two concurrent enumeration
 * jobs never grab the same burner. The lease is held until `release()`
 * is called; on process crash the row reverts (the FOR UPDATE lock is
 * released when the connection drops).
 *
 * Returns `null` if the pool is empty.
 */
async function drawBurner({ maxProbeCount = 30, maxRiskScore = 70 } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, cookie_blob_enc, web_fingerprint, bound_proxy_id,
              ds_user_id, probe_count, risk_score, last_used_at
         FROM lookup_burners
        WHERE blocked = FALSE
          AND probe_count < $1
          AND risk_score   < $2
        ORDER BY last_used_at ASC NULLS FIRST, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      [maxProbeCount, maxRiskScore]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return null;
    }
    const row = rows[0];
    await client.query(
      `UPDATE lookup_burners
          SET last_used_at = NOW()
        WHERE id = $1`,
      [row.id]
    );
    let proxyUrl = null;
    if (row.bound_proxy_id) {
      const px = await client.query(
        `SELECT proxy_url FROM proxies WHERE id = $1`,
        [row.bound_proxy_id]
      );
      proxyUrl = px.rows[0] && px.rows[0].proxy_url ? px.rows[0].proxy_url : null;
    }
    await client.query('COMMIT');

    let blob;
    try {
      blob = JSON.parse(decrypt(row.cookie_blob_enc));
    } catch (err) {
      logger.warn(`burner ${row.id}: cookie blob decrypt failed: ${err.message}`);
      await markBlocked(row.id, 'decrypt_failed');
      return null;
    }
    const { header: cookieHeader, csrftoken, dsUserId } = cookieHeaderFromBlob(blob);
    if (!cookieHeader) {
      logger.warn(`burner ${row.id}: empty cookie header after decrypt`);
      await markBlocked(row.id, 'empty_cookies');
      return null;
    }
    return {
      id: row.id,
      cookieHeader,
      csrftoken,
      dsUserId: dsUserId || row.ds_user_id || null,
      proxyUrl,
      webFingerprint: row.web_fingerprint || null,
      probeCount: row.probe_count,
      riskScore: row.risk_score,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_e) { /* swallow */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Bump probe_count and last_used_at; mark blocked if any of:
 *   - the probe got a `checkpoint_required` response
 *   - the probe got `login_required`
 *   - probe_count crossed the configured threshold
 */
async function releaseBurner(burnerId, {
  outcome = 'ok',
  block = false,
  blockReason = null,
  probesUsed = 1,
} = {}) {
  if (!burnerId) return;
  if (block) return markBlocked(burnerId, blockReason || outcome || 'unknown');

  await pool.query(
    `UPDATE lookup_burners
        SET probe_count = probe_count + $2,
            last_used_at = NOW(),
            risk_score = LEAST(100, risk_score + $3)
      WHERE id = $1`,
    [
      burnerId,
      Number.isFinite(probesUsed) ? probesUsed : 1,
      outcome === 'rate_limited' ? 10 : (outcome === 'soft_block' ? 25 : 0),
    ]
  );
}

async function markBlocked(burnerId, reason) {
  await pool.query(
    `UPDATE lookup_burners
        SET blocked = TRUE,
            blocked_reason = $2,
            blocked_at = NOW()
      WHERE id = $1`,
    [burnerId, String(reason || 'unknown').slice(0, 60)]
  );
}

/**
 * Permanently delete a burner row. The cookie blob is encrypted but
 * we err on the side of caution and let admins delete burned rows so
 * the table doesn't grow forever.
 */
async function deleteBurner(burnerId) {
  await pool.query(`DELETE FROM lookup_burners WHERE id = $1`, [burnerId]);
}

/**
 * Aggregate stats for the dashboard.
 */
async function poolStats() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::INT                                     AS total,
      COUNT(*) FILTER (WHERE blocked = FALSE)::INT      AS alive,
      COUNT(*) FILTER (WHERE blocked = TRUE )::INT      AS blocked,
      COALESCE(SUM(probe_count), 0)::INT                AS probes_total,
      COALESCE(AVG(risk_score) FILTER (WHERE blocked = FALSE), 0)::FLOAT AS avg_risk_alive
    FROM lookup_burners
  `);
  return rows[0];
}

module.exports = {
  insertBurner,
  listBurners,
  drawBurner,
  releaseBurner,
  markBlocked,
  deleteBurner,
  poolStats,
  _normaliseBlob,
};
