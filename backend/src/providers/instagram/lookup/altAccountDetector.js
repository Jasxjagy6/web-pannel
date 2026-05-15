/**
 * §2.9 Oracle 6 — alt-account / cluster detector — PR #5.5.
 *
 * Pure-DB join: for the current target's mask_hash_email and/or
 * mask_hash_phone, find every OTHER username in the panel's history
 * (in `lookup_findings` AND `lookup_snapshots`) that shares the same
 * salted hash.
 *
 * This is the "operator's collation file" — when the panel has run
 * lookups against e.g. 800 usernames in the last 6 months and they
 * all share the same masked email, this surfaces the cluster
 * automatically WITHOUT issuing a single new request to IG.
 *
 * Costs: 0 USD, 0 IG requests, 0 captchas. Just a GIN-index seek.
 */

'use strict';

const crypto = require('crypto');
const logger = require('../../../utils/logger');
const { pool } = require('../../../config/database');
const { AppError } = require('../../../utils/errorHandler');

const _MAX_NEIGHBOURS = 50;

function _maskHash(mask) {
  if (!mask) return null;
  const salt = process.env.LOOKUP_MASK_SALT || 'ig-lookup-mask-salt-v1';
  return crypto.createHash('sha256').update(`${salt}:${mask}`).digest('hex').slice(0, 32);
}

function _normaliseMask(s) {
  if (!s) return null;
  return String(s).trim().toLowerCase();
}

async function _neighboursByFindings(maskHash, selfUsername) {
  const { rows } = await pool.query(
    `SELECT DISTINCT j.username, MIN(f.created_at) AS first_seen, MAX(f.created_at) AS last_seen
       FROM lookup_findings f
       JOIN lookup_jobs j ON j.id = f.job_id
      WHERE f.mask_hash = $1
        AND j.username <> $2
      GROUP BY j.username
      ORDER BY last_seen DESC
      LIMIT $3`,
    [maskHash, selfUsername, _MAX_NEIGHBOURS]
  );
  return rows;
}

async function _neighboursBySnapshots(maskHash, selfUsername, axis /* 'email' | 'phone' */) {
  const col = axis === 'phone' ? 'mask_hash_phone' : 'mask_hash_email';
  const { rows } = await pool.query(
    `SELECT DISTINCT username, MIN(snap_at) AS first_seen, MAX(snap_at) AS last_seen
       FROM lookup_snapshots
      WHERE ${col} = $1
        AND username <> $2
      GROUP BY username
      ORDER BY last_seen DESC
      LIMIT $3`,
    [maskHash, selfUsername, _MAX_NEIGHBOURS]
  );
  return rows;
}

async function run(username, opts = {}) {
  if (!username || typeof username !== 'string') {
    throw new AppError('altAccountDetector.run: username required', 400, 'VALIDATION_ERROR');
  }
  const cleaned = username.trim().replace(/^@+/, '').toLowerCase();
  const snap = opts.resetOracleSnapshot || {};
  const findings = [];

  const emailMask = _normaliseMask(snap.obfuscated_email);
  const phoneMask = _normaliseMask(snap.obfuscated_phone);
  const emailHash = _maskHash(emailMask);
  const phoneHash = _maskHash(phoneMask);

  if (!emailHash && !phoneHash) {
    return {
      method: 'alt_account',
      ok: true,
      findings: [{
        method: 'alt_account',
        kind: 'note',
        value: 'alt-account detector: no recovery mask in snapshot — run reset_oracle first.',
        confidence: 100,
      }],
    };
  }

  // For each mask axis we have, query both lookup_findings (Stage 2
  // siblings) and lookup_snapshots (longitudinal Oracle 5 history).
  // De-dup the resulting username set.
  const clusters = { email: new Map(), phone: new Map() };

  if (emailHash) {
    const fRows = await _neighboursByFindings(emailHash, cleaned);
    const sRows = await _neighboursBySnapshots(emailHash, cleaned, 'email');
    for (const r of [...fRows, ...sRows]) {
      const u = r.username;
      const cur = clusters.email.get(u) || { first_seen: r.first_seen, last_seen: r.last_seen };
      cur.first_seen = cur.first_seen && cur.first_seen < r.first_seen ? cur.first_seen : r.first_seen;
      cur.last_seen  = cur.last_seen  && cur.last_seen  > r.last_seen  ? cur.last_seen  : r.last_seen;
      clusters.email.set(u, cur);
    }
  }
  if (phoneHash) {
    const fRows = await _neighboursByFindings(phoneHash, cleaned);
    const sRows = await _neighboursBySnapshots(phoneHash, cleaned, 'phone');
    for (const r of [...fRows, ...sRows]) {
      const u = r.username;
      const cur = clusters.phone.get(u) || { first_seen: r.first_seen, last_seen: r.last_seen };
      cur.first_seen = cur.first_seen && cur.first_seen < r.first_seen ? cur.first_seen : r.first_seen;
      cur.last_seen  = cur.last_seen  && cur.last_seen  > r.last_seen  ? cur.last_seen  : r.last_seen;
      clusters.phone.set(u, cur);
    }
  }

  // Emit one note finding per axis, plus a separate alt_username
  // finding for each unique cluster member so the UI can render
  // them as a list.
  for (const axis of ['email', 'phone']) {
    const map = clusters[axis];
    if (!map.size) continue;
    const list = [...map.entries()].map(([u, m]) => ({
      username: u,
      first_seen: m.first_seen,
      last_seen:  m.last_seen,
    }));
    const mask = axis === 'email' ? emailMask : phoneMask;
    findings.push({
      method: 'alt_account',
      kind: 'note',
      value: `shared recovery ${axis} mask "${mask}" with ${list.length} other username${list.length === 1 ? '' : 's'}: ${list.slice(0, 8).map((x) => `@${x.username}`).join(', ')}${list.length > 8 ? '…' : ''}`,
      confidence: 90,
      raw: { axis, mask, mask_hash: axis === 'email' ? emailHash : phoneHash, count: list.length, members: list.slice(0, _MAX_NEIGHBOURS) },
    });
    for (const m of list) {
      findings.push({
        method: 'alt_account',
        kind: 'username',
        value: m.username,
        confidence: 85,
        raw: { axis, mask, first_seen: m.first_seen, last_seen: m.last_seen },
      });
    }
  }

  if (!findings.length) {
    findings.push({
      method: 'alt_account',
      kind: 'note',
      value: 'alt-account detector: no cluster neighbours in panel history.',
      confidence: 100,
    });
  }

  logger.info(`IG.lookup.altAccount: ${cleaned} → emailCluster=${clusters.email.size} phoneCluster=${clusters.phone.size}`);

  return {
    method: 'alt_account',
    ok: true,
    findings,
    raw: {
      emailHash, phoneHash,
      emailClusterSize: clusters.email.size,
      phoneClusterSize: clusters.phone.size,
    },
  };
}

module.exports = {
  run,
  _maskHash,
  _normaliseMask,
};
