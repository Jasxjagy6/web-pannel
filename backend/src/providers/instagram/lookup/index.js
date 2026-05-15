/**
 * Instagram identity-lookup module entrypoint.
 *
 * Lazily wires the §2 method runners and exposes `runJob(jobId)` —
 * the BullMQ worker's executor function — which:
 *
 *   1. Resolves the job row (+ caller user_id, budget, methods).
 *   2. Acquires the best logged-in IG session for the cookie-gated
 *      methods (currently `geo_from_posts`; later PRs add more).
 *   3. Iterates the requested methods. Each method:
 *      - is one of the entries in `METHODS`
 *      - is gated by the matching `lookup_*` capability flag
 *      - is rate-limited via `lookupLimiter`
 *      - returns { ok, findings, raw, cost_usd_estimate? }
 *   4. Persists findings via `lookupService.recordFindings(jobId, ...)`.
 *   5. Streams `lookup_progress` over Socket.IO as each method
 *      finishes.
 *   6. Stops cleanly on cancellation (lookup_jobs.status==='cancelled'
 *      is observed before each method).
 *
 * This file is intentionally thin — every method's logic lives in
 * its own file so the upgrade plan's PR-by-PR sequence stays a 1:1
 * mapping (add a file per PR, register it here, done).
 */

'use strict';

const { pool } = require('../../../config/database');
const logger = require('../../../utils/logger');

const profileInfo  = require('./profileInfo');
const resetOracle  = require('./resetOracle');
const crossPlatform = require('./crossPlatform');
const geoFromPosts = require('./geoFromPosts');
const googleDork   = require('./googleDork');
const emailEnumerator = require('./emailEnumerator');
const phoneEnumerator = require('./phoneEnumerator');
const candidateGenerator = require('./candidateGenerator');

/**
 * The set of methods this PR knows how to run. Each entry maps the
 * caller-visible method code to its run() function and the capability
 * flag that gates it. Methods absent from this map either belong to a
 * later PR or are forever forbidden (§3, §10).
 *
 * `capability` is the capability key on providers/instagram/index.js;
 * the runner short-circuits with `not_implemented` when the flag is
 * false so the operator can see exactly which method is gated off.
 */
const METHODS = {
  profile_info:    { runner: profileInfo,    capability: 'lookup_public_profile' },
  reset_oracle:    { runner: resetOracle,    capability: 'lookup_recovery' },
  cross_platform:  { runner: crossPlatform,  capability: 'lookup_cross_platform' },
  geo_from_posts:  { runner: geoFromPosts,   capability: 'lookup_geo' },
  dork:            { runner: googleDork,     capability: 'lookup_dork' },
  // PR #4 — burner-pool enumerators. Both require a populated burner
  // pool; when empty they return a `no_burner_available` note finding
  // so the operator sees exactly what to do next.
  email_enum:      { runner: emailEnumerator,    capability: 'lookup_email_enumerate' },
  phone_enum:      { runner: phoneEnumerator,    capability: 'lookup_phone_enumerate' },
  // Stubs for the methods that still need PR #5/#5.5/#6 infra. Calling
  // them surfaces a `not_implemented` note instead of a hard failure
  // so the runner can complete and the operator sees the gap.
  breach:          { runner: _notImplemented('breach',         'Requires Dehashed/LeakCheck/Snusbase keys — see PR #5'), capability: 'lookup_breach' },
  link_expand:     { runner: _notImplemented('link_expand',    'Link expansion + WHOIS — see PR #5'),          capability: 'lookup_link_expand' },
  reverse_image:   { runner: _notImplemented('reverse_image',  'Reverse-image (Yandex+PimEyes) — see PR #6'),   capability: 'lookup_reverse_image' },
};

function _notImplemented(code, message) {
  return {
    run: async (_username, _opts) => ({
      method: code,
      ok: false,
      error: 'not_implemented',
      message,
      findings: [{
        method: code,
        kind: 'note',
        value: `${code} not yet implemented: ${message}`,
        confidence: 100,
      }],
    }),
  };
}

/**
 * Resolve a usable IG session for the cookie-gated methods.
 * Strategy: pick the operator's healthiest logged-in IG session.
 * For PR #1 we accept any logged-in session; later PRs will narrow
 * this to ones with `proxies.validated_for_lookup = true`.
 */
async function _resolveSessionFor(userId) {
  const { rows } = await pool.query(
    `SELECT id, username, session_data, proxy_url, is_logged_in, platform_state
       FROM sessions
      WHERE user_id = $1
        AND platform = 'instagram'
        AND is_logged_in = TRUE
      ORDER BY last_used DESC NULLS LAST, last_active DESC NULLS LAST
      LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function _getJob(jobId) {
  const { rows } = await pool.query(
    `SELECT * FROM lookup_jobs WHERE id = $1`,
    [jobId]
  );
  return rows[0] || null;
}

async function _setJobStatus(jobId, status, extra = {}) {
  const fields = [`status = $2`];
  const params = [jobId, status];
  let idx = 3;
  if (extra.startedAt) { fields.push(`started_at = $${idx}`); params.push(extra.startedAt); idx += 1; }
  if (extra.completedAt) { fields.push(`completed_at = $${idx}`); params.push(extra.completedAt); idx += 1; }
  if (extra.error) { fields.push(`error = $${idx}`); params.push(extra.error); idx += 1; }
  await pool.query(
    `UPDATE lookup_jobs SET ${fields.join(', ')} WHERE id = $1`,
    params
  );
}

async function _bumpCounters(jobId, patch) {
  const fields = [];
  const params = [jobId];
  let idx = 2;
  if (patch.completed != null) { fields.push(`completed_methods = $${idx}`); params.push(patch.completed); idx += 1; }
  if (patch.errors != null)    { fields.push(`error_methods = $${idx}`); params.push(patch.errors); idx += 1; }
  if (patch.findings != null)  { fields.push(`total_findings = $${idx}`); params.push(patch.findings); idx += 1; }
  if (patch.spent != null)     { fields.push(`budget_usd_spent = $${idx}`); params.push(patch.spent); idx += 1; }
  if (!fields.length) return;
  await pool.query(
    `UPDATE lookup_jobs SET ${fields.join(', ')} WHERE id = $1`,
    params
  );
}

async function _emitProgress(job, snapshot) {
  // Socket.IO is global.io — same convention as scrapeService.
  if (global.io) {
    try {
      global.io.emit('lookup_progress', {
        jobId: job.id,
        userId: job.user_id,
        username: job.username,
        ...snapshot,
      });
    } catch (err) {
      logger.warn(`IG.lookup: socket emit failed: ${err.message}`);
    }
  }
}

async function _persistFindings(jobId, findings) {
  if (!findings || !findings.length) return 0;
  const values = [];
  const placeholders = [];
  let idx = 1;
  for (const f of findings) {
    const base = idx;
    placeholders.push(`($${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`);
    values.push(
      jobId,
      f.method || 'note',
      f.kind || 'note',
      f.value == null ? null : String(f.value).slice(0, 4000),
      f.raw == null ? null : JSON.stringify(f.raw),
      f.sourceUrl || f.source_url || null,
      Number.isFinite(f.confidence) ? f.confidence : 50,
      !!f.verified,
    );
    idx += 8;
  }
  await pool.query(
    `INSERT INTO lookup_findings (job_id, method, kind, value, raw, source_url, confidence, verified)
     VALUES ${placeholders.join(', ')}`,
    values
  );
  return findings.length;
}

async function _isCancelled(jobId) {
  const { rows } = await pool.query(`SELECT status FROM lookup_jobs WHERE id = $1`, [jobId]);
  return rows[0] && rows[0].status === 'cancelled';
}

/**
 * Capability check — pulls the live IG provider capability map so the
 * runner respects the same flags the React sidebar respects.
 */
function _capabilityEnabled(key) {
  if (!key) return true;
  // eslint-disable-next-line global-require
  const provider = require('../../instagram');
  return !!(provider.capabilities && provider.capabilities[key]);
}

/**
 * Run a single method against a username. Bounded by the method
 * runner's internal limiter + the per-job budget check above.
 */
async function _runMethod(methodCode, job, opts) {
  const entry = METHODS[methodCode];
  if (!entry) {
    return { method: methodCode, ok: false, error: 'unknown_method', findings: [] };
  }
  if (!_capabilityEnabled(entry.capability)) {
    return {
      method: methodCode,
      ok: false,
      error: 'capability_disabled',
      message: `capability ${entry.capability} is disabled on this provider`,
      findings: [],
    };
  }
  try {
    return await entry.runner.run(job.username, opts);
  } catch (err) {
    return {
      method: methodCode,
      ok: false,
      error: err.kind || 'exception',
      message: err.message || String(err),
      findings: [],
    };
  }
}

/**
 * Run a single lookup job. This is the function registered as the
 * BullMQ worker executor.
 */
async function runJob(jobId) {
  const job = await _getJob(jobId);
  if (!job) {
    logger.warn(`IG.lookup.runJob: job ${jobId} not found`);
    return { ok: false, error: 'job_not_found' };
  }
  if (job.status === 'cancelled') {
    logger.info(`IG.lookup.runJob: job ${jobId} already cancelled`);
    return { ok: false, error: 'cancelled' };
  }

  await _setJobStatus(jobId, 'running', { startedAt: new Date() });
  await _emitProgress(job, { status: 'running' });

  const session = await _resolveSessionFor(job.user_id);
  if (!session) {
    logger.info(`IG.lookup.runJob: no IG session for user ${job.user_id} — cookie-gated methods will return session_required`);
  }

  const methods = Array.isArray(job.methods) && job.methods.length
    ? job.methods
    : Object.keys(METHODS);

  let completed = 0;
  let errors = 0;
  let findingsCount = 0;
  let spentUsd = Number(job.budget_usd_spent || 0);
  const budgetCap = Number(job.budget_usd_cap || 0);

  // Methods communicate downstream context via `sharedCtx`. Earlier
  // methods set fields here (e.g. reset_oracle stores its mask snapshot)
  // so later methods (email_enum, phone_enum, breach, link_expand) can
  // pick them up without re-querying.
  const sharedCtx = {
    resetOracleSnapshot: null,
    profileInfo: null,
  };

  for (const methodCode of methods) {
    if (await _isCancelled(jobId)) {
      logger.info(`IG.lookup.runJob: job ${jobId} cancelled mid-flight`);
      break;
    }

    const opts = {
      session,
      budgetUsdCap: budgetCap > 0 ? Math.max(0, budgetCap - spentUsd) : 0,
      serpApiKey: (job.options && job.options.serpApiKey) || process.env.SERPAPI_KEY || null,
      resetOracleSnapshot: sharedCtx.resetOracleSnapshot,
      profileInfoSnapshot: sharedCtx.profileInfo,
      targetMask: methodCode === 'email_enum'
        ? (sharedCtx.resetOracleSnapshot && sharedCtx.resetOracleSnapshot.obfuscated_email) || null
        : methodCode === 'phone_enum'
          ? (sharedCtx.resetOracleSnapshot && sharedCtx.resetOracleSnapshot.obfuscated_phone) || null
          : null,
      jobOptions: job.options || {},
      userId: job.user_id,
    };
    const result = await _runMethod(methodCode, job, opts);
    if (result.ok === false) errors += 1; else completed += 1;
    if (Number(result.cost_usd_estimate) > 0) spentUsd += Number(result.cost_usd_estimate);
    const resultFindings = Array.isArray(result.findings) ? result.findings.slice() : [];
    // Surface method-level errors as `note` findings so the operator
    // can tell *why* a method returned nothing (login_required,
    // proxy_required, rate_limited, etc.) instead of seeing a blank
    // panel.
    if (result.ok === false) {
      resultFindings.push({
        method: methodCode,
        kind: 'note',
        value: `${methodCode} failed: ${result.error || 'error'}${
          result.message ? ` — ${String(result.message).slice(0, 200)}` : ''
        }`,
        confidence: 0,
        raw: { error: result.error || null, message: result.message || null },
      });
    }
    findingsCount += await _persistFindings(jobId, resultFindings);

    // Capture downstream-relevant snapshots for the next iteration.
    if (methodCode === 'reset_oracle' && result.ok && result.snapshot) {
      sharedCtx.resetOracleSnapshot = result.snapshot;
    }
    if (methodCode === 'profile_info' && result.ok && result.raw) {
      sharedCtx.profileInfo = result.raw;
    }

    // If oracle 1+2+3 returned mask hashes, surface candidates as
    // INFORMATIONAL findings so PR #4 has them ready to enumerate.
    if (methodCode === 'reset_oracle' && result.ok && result.snapshot) {
      const emailMask = result.snapshot.obfuscated_email;
      const phoneMask = result.snapshot.obfuscated_phone;
      const candFindings = [];
      if (emailMask) {
        const cands = candidateGenerator.emailCandidates(emailMask, job.username);
        if (cands.length) {
          candFindings.push({
            method: 'reset_oracle',
            kind: 'note',
            value: `email candidates ready for enumeration: ${cands.length} (top-5 confidence): ${
              cands.slice(0, 5).map((c) => `${c.email} (${c.confidence})`).join(', ')
            }`,
            confidence: 60,
            raw: { mask: emailMask, candidates: cands.slice(0, 50) },
          });
        }
      }
      if (phoneMask) {
        const cands = candidateGenerator.phoneCandidates(phoneMask);
        if (cands.length) {
          candFindings.push({
            method: 'reset_oracle',
            kind: 'note',
            value: `phone candidates ready for enumeration: ${cands.length} (top-5): ${
              cands.slice(0, 5).map((c) => `${c.phone} (${c.confidence})`).join(', ')
            }`,
            confidence: 60,
            raw: { mask: phoneMask, candidates: cands.slice(0, 50) },
          });
        }
      }
      if (candFindings.length) {
        findingsCount += await _persistFindings(jobId, candFindings);
      }
    }

    await _bumpCounters(jobId, { completed, errors, findings: findingsCount, spent: spentUsd });
    await _emitProgress(job, {
      method: methodCode,
      methodOk: !!result.ok,
      methodError: result.ok === false ? (result.error || 'error') : null,
      completed,
      errors,
      findings: findingsCount,
      spentUsd,
    });
  }

  await _setJobStatus(jobId, 'completed', { completedAt: new Date() });
  await _emitProgress(job, {
    status: 'completed',
    completed,
    errors,
    findings: findingsCount,
    spentUsd,
  });

  return {
    ok: true,
    completed,
    errors,
    findings: findingsCount,
    spentUsd,
  };
}

module.exports = {
  METHODS,
  runJob,
  // Exported for tests + later PRs.
  _resolveSessionFor,
  _capabilityEnabled,
};
