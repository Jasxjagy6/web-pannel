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
const resetOracleDeep = require('./resetOracleDeep');
const altAccountDetector = require('./altAccountDetector');
const crossPlatform = require('./crossPlatform');
const geoFromPosts = require('./geoFromPosts');
const googleDork   = require('./googleDork');
const emailEnumerator = require('./emailEnumerator');
const phoneEnumerator = require('./phoneEnumerator');
const breachCorrelator = require('./breachCorrelator');
const linkExpander = require('./linkExpander');
const reverseImage = require('./reverseImage');
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
  // ---- Stage 1: cheap, anonymous, parallel-safe ------------------
  profile_info:    { runner: profileInfo,    capability: 'lookup_public_profile',   stage: 1 },
  cross_platform:  { runner: crossPlatform,  capability: 'lookup_cross_platform',   stage: 1 },
  dork:            { runner: googleDork,     capability: 'lookup_dork',             stage: 1 },
  geo_from_posts:  { runner: geoFromPosts,   capability: 'lookup_geo',              stage: 1 },
  reverse_image:   { runner: reverseImage,   capability: 'lookup_reverse_image',    stage: 1 },

  // ---- Stage 2: cookie/probe-gated, includes Oracle 1-4 + alt -----
  reset_oracle:        { runner: resetOracle,        capability: 'lookup_recovery',          stage: 2 },
  reset_oracle_deep:   { runner: resetOracleDeep,    capability: 'lookup_recovery_deep',     stage: 2 },
  alt_account:         { runner: altAccountDetector, capability: 'lookup_alt_account',       stage: 2 },
  email_enum:          { runner: emailEnumerator,    capability: 'lookup_email_enumerate',   stage: 2 },
  phone_enum:          { runner: phoneEnumerator,    capability: 'lookup_phone_enumerate',   stage: 2 },

  // ---- Stage 3: paid outbound (breach DBs, link expansion) --------
  breach:          { runner: breachCorrelator,   capability: 'lookup_breach',           stage: 3 },
  link_expand:     { runner: linkExpander,       capability: 'lookup_link_expand',      stage: 3 },
};

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

function _maskHashOf(finding) {
  if (!finding) return null;
  const isRecoveryMask = finding.method === 'recovery_mask' || finding.method === 'reset_oracle';
  if (!isRecoveryMask) return null;
  if (finding.kind !== 'email' && finding.kind !== 'phone') return null;
  const mask = finding.value;
  if (!mask) return null;
  // eslint-disable-next-line global-require
  const crypto = require('crypto');
  const salt = process.env.LOOKUP_MASK_SALT || 'ig-lookup-mask-salt-v1';
  return crypto.createHash('sha256').update(`${salt}:${mask}`).digest('hex').slice(0, 32);
}

async function _persistFindings(jobId, findings) {
  if (!findings || !findings.length) return 0;
  const values = [];
  const placeholders = [];
  let idx = 1;
  for (const f of findings) {
    const base = idx;
    placeholders.push(`($${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`);
    values.push(
      jobId,
      f.method || 'note',
      f.kind || 'note',
      f.value == null ? null : String(f.value).slice(0, 4000),
      f.raw == null ? null : JSON.stringify(f.raw),
      f.sourceUrl || f.source_url || null,
      Number.isFinite(f.confidence) ? f.confidence : 50,
      !!f.verified,
      _maskHashOf(f),
    );
    idx += 9;
  }
  await pool.query(
    `INSERT INTO lookup_findings (job_id, method, kind, value, raw, source_url, confidence, verified, mask_hash)
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
    profilePicUrl: null,
    bioLinks: [],
    confirmedEmails: [],
    confirmedPhones: [],
  };

  // Stage timing — per-stage wall-time so PR #8 SLO dashboard can show
  // p50/p95 across the panel's last 24h of jobs.
  const stageStarts = {};
  const stageEnds = {};
  function _stageStart(s) { if (!stageStarts[s]) stageStarts[s] = Date.now(); }
  function _stageEnd(s) { stageEnds[s] = Date.now(); }

  // Force stage-ordered execution. Within a stage we preserve operator
  // order; across stages we always run 1 → 2 → 3. This lets stage-1
  // outputs (profile_info, reverse_image bytes) feed stage-2 inputs.
  const orderedMethods = (() => {
    const buckets = { 1: [], 2: [], 3: [] };
    for (const m of methods) {
      const s = (METHODS[m] && METHODS[m].stage) || 1;
      buckets[s].push(m);
    }
    return [].concat(buckets[1], buckets[2], buckets[3]);
  })();

  for (const methodCode of orderedMethods) {
    if (await _isCancelled(jobId)) {
      logger.info(`IG.lookup.runJob: job ${jobId} cancelled mid-flight`);
      break;
    }

    const stage = (METHODS[methodCode] && METHODS[methodCode].stage) || 1;
    _stageStart(stage);
    const opts = {
      session,
      budgetUsdCap: budgetCap > 0 ? Math.max(0, budgetCap - spentUsd) : 0,
      serpApiKey: (job.options && job.options.serpApiKey) || process.env.SERPAPI_KEY || null,
      resetOracleSnapshot: sharedCtx.resetOracleSnapshot,
      profileInfoSnapshot: sharedCtx.profileInfo,
      profilePicUrl: sharedCtx.profilePicUrl,
      confirmedEmails: sharedCtx.confirmedEmails,
      confirmedPhones: sharedCtx.confirmedPhones,
      candidateEmails: sharedCtx.candidateEmails,
      altUsernames: sharedCtx.altUsernames,
      maskedEmail: sharedCtx.resetOracleSnapshot && sharedCtx.resetOracleSnapshot.obfuscated_email,
      maskedPhone: sharedCtx.resetOracleSnapshot && sharedCtx.resetOracleSnapshot.obfuscated_phone,
      fullName: sharedCtx.fullName,
      targetMask: methodCode === 'email_enum'
        ? (sharedCtx.resetOracleSnapshot && sharedCtx.resetOracleSnapshot.obfuscated_email) || null
        : methodCode === 'phone_enum'
          ? (sharedCtx.resetOracleSnapshot && sharedCtx.resetOracleSnapshot.obfuscated_phone) || null
          : null,
      jobOptions: job.options || {},
      jobId,
      userId: job.user_id,
    };
    const tMethodStart = Date.now();
    const result = await _runMethod(methodCode, job, opts);
    const tMethodEnd = Date.now();
    _stageEnd(stage);
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
      const u = result.raw && result.raw.data && result.raw.data.user;
      if (u) {
        if (u.profile_pic_url_hd || u.profile_pic_url) {
          sharedCtx.profilePicUrl = u.profile_pic_url_hd || u.profile_pic_url;
        }
        if (u.full_name) sharedCtx.fullName = u.full_name;
        if (u.external_url) sharedCtx.bioLinks.push(u.external_url);
        if (Array.isArray(u.bio_links)) {
          for (const l of u.bio_links) if (l && l.url) sharedCtx.bioLinks.push(l.url);
        }
      }
    }
    // Capture confirmed primitives surfaced by the burner-pool
    // enumerators so the breach correlator can search on them.
    if (methodCode === 'email_enum' && result.ok && Array.isArray(result.findings)) {
      for (const f of result.findings) {
        if (f.kind === 'email' && f.value) sharedCtx.confirmedEmails.push(String(f.value).toLowerCase());
      }
    }
    if (methodCode === 'phone_enum' && result.ok && Array.isArray(result.findings)) {
      for (const f of result.findings) {
        if (f.kind === 'phone' && f.value) sharedCtx.confirmedPhones.push(String(f.value));
      }
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

  // Compute per-stage durations + finalize.
  const stageDurations = {};
  for (const s of [1, 2, 3]) {
    if (stageStarts[s] && stageEnds[s]) stageDurations[`stage${s}`] = stageEnds[s] - stageStarts[s];
  }
  if (stageDurations.stage1 || stageDurations.stage2 || stageDurations.stage3) {
    stageDurations.total = (stageDurations.stage1 || 0) + (stageDurations.stage2 || 0) + (stageDurations.stage3 || 0);
    try {
      await pool.query(
        `UPDATE lookup_jobs
            SET stage_p50_ms = $2::jsonb,
                stage_p95_ms = $2::jsonb
          WHERE id = $1`,
        [jobId, JSON.stringify(stageDurations)]
      );
    } catch (err) {
      logger.warn(`IG.lookup.runJob: stage timing persist failed: ${err.message}`);
    }
  }

  await _setJobStatus(jobId, 'completed', { completedAt: new Date() });
  await _emitProgress(job, {
    status: 'completed',
    completed,
    errors,
    findings: findingsCount,
    spentUsd,
    stageDurations,
  });

  return {
    ok: true,
    completed,
    errors,
    findings: findingsCount,
    spentUsd,
    stageDurations,
  };
}

module.exports = {
  METHODS,
  runJob,
  // Exported for tests + later PRs.
  _resolveSessionFor,
  _capabilityEnabled,
};
