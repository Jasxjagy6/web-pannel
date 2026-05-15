/**
 * §2.9 Oracle 5 — longitudinal watch + diff producer — PR #7.
 *
 * On each scheduled tick (or on-demand via the watch UI's "Run now"
 * button) we:
 *   1. Run `resetOracle.run(username)` and capture the full snapshot.
 *   2. Insert a row into `lookup_snapshots` with the mask hashes
 *      pre-computed.
 *   3. Compare to the most recent prior snapshot of the same username
 *      for the same user and produce a structured diff. The diff is
 *      stored as JSONB on the new row AND surfaced as
 *      `method='reset_oracle_diff'` findings on the associated
 *      watch's last job.
 *
 * The diff schema:
 *   {
 *     prev_snapshot_id: 42,
 *     prev_snap_at: '2024-12-01T03:00:00Z',
 *     curr_snap_at: '2024-12-02T03:00:00Z',
 *     changes: [
 *       { field: 'obfuscated_email',
 *         from: 'g***@gmail.com',
 *         to:   'a***@protonmail.com' },
 *       { field: 'recovery_methods.fb_linked',
 *         from: true,
 *         to:   false },
 *       { field: 'status',
 *         from: 'active',
 *         to:   'checkpointed' },
 *     ],
 *   }
 *
 * Side effects:
 *   - Socket.IO push to `user:{userId}` room with event
 *     `lookup_watch_diff` when changes.length > 0.
 *   - Audit-log row (action=watch_diff) — retention 365d so an
 *     operator can replay a year of recovery-mask drift.
 */

'use strict';

const crypto = require('crypto');
const logger = require('../../../utils/logger');
const { pool } = require('../../../config/database');
const resetOracle = require('./resetOracle');
const lookupAudit = require('../../../services/lookupAuditService');

function _maskHash(mask) {
  if (!mask) return null;
  const salt = process.env.LOOKUP_MASK_SALT || 'ig-lookup-mask-salt-v1';
  return crypto.createHash('sha256').update(`${salt}:${mask}`).digest('hex').slice(0, 32);
}

function _diff(prev, curr) {
  const changes = [];
  if (!prev) return changes;
  const a = prev.snap || {};
  const b = curr.snapshot || curr.snap || {};
  for (const k of ['obfuscated_email', 'obfuscated_phone', 'status']) {
    if (a[k] !== b[k]) {
      changes.push({ field: k, from: a[k] || null, to: b[k] || null });
    }
  }
  const ma = (a.methodsBitmap || {});
  const mb = (b.methodsBitmap || {});
  const allKeys = new Set([...Object.keys(ma), ...Object.keys(mb)]);
  for (const k of allKeys) {
    if (!!ma[k] !== !!mb[k]) {
      changes.push({ field: `recovery_methods.${k}`, from: !!ma[k], to: !!mb[k] });
    }
  }
  return changes;
}

/**
 * @param {Object} args
 * @param {string} args.username
 * @param {number} args.userId
 * @param {number} [args.watchId]
 * @returns {Promise<{ snapshot_id, changes, snap }>}
 */
async function run({ username, userId, watchId = null }) {
  const cleaned = String(username || '').trim().replace(/^@+/, '').toLowerCase();
  if (!cleaned) throw new Error('username required');
  // Pull the most recent prior snapshot to diff against.
  const prior = await pool.query(
    `SELECT id, snap, snap_at, mask_hash_email, mask_hash_phone
       FROM lookup_snapshots
      WHERE user_id = $1 AND username = $2
      ORDER BY snap_at DESC LIMIT 1`,
    [userId || null, cleaned]
  );
  const prev = prior.rows[0] || null;

  const oracleResult = await resetOracle.run(cleaned, { userId, jobOptions: { watchMode: true } });
  const snap = oracleResult.snapshot || {};
  const changes = _diff(prev, oracleResult);

  const diffPayload = prev ? {
    prev_snapshot_id: prev.id,
    prev_snap_at: prev.snap_at,
    curr_snap_at: new Date().toISOString(),
    changes,
  } : { changes: [] };

  const ins = await pool.query(
    `INSERT INTO lookup_snapshots
       (user_id, username, ig_pk, snap, mask_hash_email, mask_hash_phone, diff_from_prev)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb)
     RETURNING id, snap_at`,
    [
      userId || null,
      cleaned,
      null,
      JSON.stringify(snap),
      _maskHash(snap.obfuscated_email),
      _maskHash(snap.obfuscated_phone),
      JSON.stringify(diffPayload),
    ]
  );
  const newRow = ins.rows[0];

  if (changes.length) {
    const summary = `${cleaned}: ${changes.length} change${changes.length === 1 ? '' : 's'}: ${
      changes.map((c) => `${c.field} ${JSON.stringify(c.from)}→${JSON.stringify(c.to)}`).slice(0, 4).join('; ')
    }`;
    // Socket.IO push
    if (global.io && userId) {
      try {
        global.io.to(`user:${userId}`).emit('lookup_watch_diff', {
          watch_id: watchId,
          username: cleaned,
          snapshot_id: newRow.id,
          snap_at: newRow.snap_at,
          changes,
          summary,
        });
      } catch (err) {
        logger.warn(`resetOracleWatch: socket emit failed: ${err.message}`);
      }
    }
    lookupAudit.log({
      userId, username: cleaned, action: 'watch_diff',
      method: 'reset_oracle_watch',
      meta: { watch_id: watchId, snapshot_id: newRow.id, changes },
      retentionDays: 365,
    });
    if (watchId) {
      await pool.query(
        `UPDATE lookup_watches
            SET last_diff_summary   = $2,
                last_findings_count = $3
          WHERE id = $1`,
        [watchId, summary.slice(0, 800), changes.length]
      );
    }
  }

  logger.info(`IG.lookup.resetOracleWatch: ${cleaned} → snapshot_id=${newRow.id} changes=${changes.length}`);
  return {
    snapshot_id: newRow.id,
    snap_at: newRow.snap_at,
    changes,
    snap,
  };
}

module.exports = { run, _diff, _maskHash };
