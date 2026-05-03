/**
 * Instagram identity / device fingerprint (provider.identity.*).
 *
 * Phase 1 hardening:
 *   - `getOrCreateSeed(session)` is the single source of truth for the
 *     device fingerprint seed. It returns `platform_state.fingerprint.seed`
 *     if set, otherwise generates ONE and persists it before returning so
 *     the very next call sees the same value.
 *   - `getOrCreatePlatformState(session)` rolls the seed + the pinned
 *     app version + the pinned locale + (later) the pinned web
 *     fingerprint into a single hydrated object that the rest of the
 *     IG provider reads from. All defaults are derived deterministically
 *     from the seed so two parallel callers can't race and pin different
 *     values for the same session.
 *   - `generate({ userId, sessionId, seed, force })` is now an explicit,
 *     gated rotation operator (account age >= 30 days, last rotation >=
 *     60 days). Used as a remediation step when an account is flagged.
 *     `force=true` bypasses the gate (admin-only, not exposed to the UI).
 */

'use strict';

const { pool } = require('../../config/database');
const igClient = require('./client');
const logger = require('../../utils/logger');
const { randomUUID } = require('crypto');

const clientFactory = require('./clientFactory');

const ROTATE_MIN_AGE_DAYS = 30;
const ROTATE_COOLDOWN_DAYS = 60;

async function _session({ userId, sessionId }) {
  const r = await pool.query(
    `SELECT id, user_id, username, proxy_url, session_data, platform_state,
            created_at
       FROM sessions
      WHERE id = $1 AND user_id = $2 AND platform = 'instagram'`,
    [sessionId, userId]
  );
  if (r.rows.length === 0) {
    const e = new Error('Instagram session not found');
    e.statusCode = 404;
    throw e;
  }
  return r.rows[0];
}

function _ageDays(createdAt) {
  if (!createdAt) return 0;
  const ms = Date.now() - new Date(createdAt).getTime();
  return Math.max(0, Math.floor(ms / (24 * 3600 * 1000)));
}

async function _persistPlatformState(sessionId, ps) {
  await pool.query(
    `UPDATE sessions
        SET platform_state = $1::jsonb,
            updated_at = NOW()
      WHERE id = $2`,
    [JSON.stringify(ps), sessionId]
  );
}

/**
 * Return the fingerprint seed for this session, generating + persisting
 * one if none is set yet. Idempotent — safe to call from any code path
 * that needs the seed.
 *
 * Persisted under `platform_state.fingerprint.seed`. We never overwrite
 * an existing seed from this function; the only way to change a seed
 * is via the explicit `generate()` rotation operator.
 */
async function getOrCreateSeed(sessionRow) {
  const ps = sessionRow.platform_state || {};
  if (ps.fingerprint && ps.fingerprint.seed) {
    return { seed: ps.fingerprint.seed, platformState: ps, created: false };
  }

  // Two upload paths historically used different seed schemes. We
  // preserve the existing convention so already-uploaded sessions get
  // a stable answer:
  //   - cookie uploads embedded `ig_${dsUserId}` in platform_state (we
  //     read it from `platform_state.ig_pk` which cookieAdapter sets).
  //   - interactive logins seeded with the username (client.js).
  // For anything else, fall back to `${username}_${randomUUID()}` so
  // every session is unique even if username collides across rows.
  let seed;
  if (ps.ig_pk) {
    seed = `ig_${ps.ig_pk}`;
  } else if (sessionRow.username) {
    seed = `${sessionRow.username}_${randomUUID()}`;
  } else {
    seed = `ig_${sessionRow.id}_${randomUUID()}`;
  }

  ps.fingerprint = Object.assign({}, ps.fingerprint, {
    seed,
    created_at: new Date().toISOString(),
  });
  await _persistPlatformState(sessionRow.id, ps);
  logger.info(`IG.identity.getOrCreateSeed sessionId=${sessionRow.id} seed=${seed}`);
  return { seed, platformState: ps, created: true };
}

/**
 * Hydrate the per-session pinned fingerprint slots (seed, appVersion,
 * locale). Persists any that were missing so subsequent calls return
 * the exact same values.
 *
 * Returns `{ seed, appVersion, locale, apiMode, platformState }`.
 */
async function getOrCreatePlatformState(sessionRow) {
  const { seed, platformState } = await getOrCreateSeed(sessionRow);
  const ps = platformState;
  let dirty = false;

  if (!ps.appVersion || !ps.appVersion.app_version) {
    ps.appVersion = clientFactory.pickAppVersion(seed);
    dirty = true;
  }

  if (!ps.locale || !ps.locale.language) {
    // Region hint comes from the proxy egress region if the operator
    // already set it via `proxies.assign({ regionHint })`, otherwise
    // we default to US.
    const regionHint = (ps.locale && ps.locale.regionHint) || ps.region_hint || 'US';
    ps.locale = clientFactory.buildDefaultLocale(regionHint);
    dirty = true;
  }

  if (!ps.api_mode) {
    // Cookie-uploaded sessions have `source: 'browser_cookies'`. They
    // MUST NOT use the mobile API — IG flags any `i.instagram.com`
    // call against a sessionid that was issued by a browser as
    // "session moved to a new device".
    ps.api_mode = ps.source === 'browser_cookies' ? 'web' : 'mobile';
    dirty = true;
  }

  if (dirty) {
    await _persistPlatformState(sessionRow.id, ps);
  }

  return {
    seed,
    appVersion: ps.appVersion,
    locale: ps.locale,
    apiMode: ps.api_mode,
    platformState: ps,
  };
}

/**
 * Explicit, gated rotation operator. Generates a new seed and
 * regenerates the device fingerprint (deviceId / uuid / phoneId / adid
 * / build) so the account looks like it moved to a new physical phone.
 * Use this only as remediation after an account is flagged — random
 * rotations themselves trip detection.
 *
 *   await provider.identity.generate({ userId, sessionId, force?, seed? })
 */
async function generate({ userId, sessionId, seed = null, force = false }) {
  const session = await _session({ userId, sessionId });
  const ps = session.platform_state || {};
  const ageDays = _ageDays(session.created_at);
  const lastRotationIso = ps.fingerprint && ps.fingerprint.rotated_at;
  const daysSinceRotation = lastRotationIso
    ? Math.floor((Date.now() - new Date(lastRotationIso).getTime()) / (24 * 3600 * 1000))
    : Infinity;

  if (!force) {
    if (ageDays < ROTATE_MIN_AGE_DAYS) {
      const e = new Error(
        `Cannot rotate device fingerprint on a session younger than ${ROTATE_MIN_AGE_DAYS} days ` +
        `(this session is ${ageDays} days old). Rotating fresh accounts trips Instagram's ` +
        `"new device" check immediately. Use force=true to override.`
      );
      e.statusCode = 409;
      e.code = 'AGED_SESSION_REQUIRED';
      throw e;
    }
    if (daysSinceRotation < ROTATE_COOLDOWN_DAYS) {
      const e = new Error(
        `Device fingerprint was already rotated ${daysSinceRotation} days ago. ` +
        `Wait at least ${ROTATE_COOLDOWN_DAYS} days between rotations or use force=true.`
      );
      e.statusCode = 409;
      e.code = 'ROTATION_COOLDOWN';
      throw e;
    }
  }

  const newSeed = seed || `${session.username || `ig_${session.id}`}_${randomUUID()}`;

  // Drop the cached client so the next getClient() picks up the new seed.
  igClient.releaseClient(session.id);

  // Build a fresh pinned client just to compute the deterministic
  // device fields we want to persist (deviceId, uuid, phoneId, adid,
  // build). We don't keep this client — the pool will rebuild one on
  // next use.
  const { client } = clientFactory.createPinnedClient({
    seed: newSeed,
    proxyUrl: session.proxy_url || null,
  });

  ps.fingerprint = {
    seed: newSeed,
    deviceId: client.state.deviceId,
    uuid: client.state.uuid,
    phoneId: client.state.phoneId,
    adid: client.state.adid,
    build: client.state.build,
    rotated_at: new Date().toISOString(),
    created_at: (ps.fingerprint && ps.fingerprint.created_at) || new Date().toISOString(),
  };
  // Re-pin app version too so the rotation looks like a clean new
  // install on a new phone (consistent with the new device).
  ps.appVersion = clientFactory.pickAppVersion(newSeed);

  await _persistPlatformState(session.id, ps);
  logger.info(`IG.identity.generate session=${session.id} seed=${newSeed} (age=${ageDays}d)`);
  return ps.fingerprint;
}

async function list({ userId, sessionId }) {
  const session = await _session({ userId, sessionId });
  const ps = session.platform_state || {};
  return ps.fingerprint || null;
}

async function assign({ userId, sessionId, fingerprint }) {
  const session = await _session({ userId, sessionId });
  const ps = session.platform_state || {};
  ps.fingerprint = Object.assign({}, fingerprint, { assigned_at: new Date().toISOString() });
  await _persistPlatformState(session.id, ps);
  return ps.fingerprint;
}

module.exports = {
  generate,
  generateIdentity: generate,
  list,
  listIdentities: list,
  assign,
  assignIdentity: assign,
  getOrCreateSeed,
  getOrCreatePlatformState,
};
