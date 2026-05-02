/**
 * Instagram identity / device fingerprint (provider.identity.*).
 *
 * Each IG session keeps a stable device fingerprint in
 * `sessions.platform_state.fingerprint` and inside the encrypted
 * session_data blob. Reseeding via this module rotates the fingerprint
 * (rare — used as a remediation step when an account is flagged).
 */

const { pool } = require('../../config/database');
const igClient = require('./client');
const logger = require('../../utils/logger');
const { randomUUID } = require('crypto');

async function _session({ userId, sessionId }) {
  const r = await pool.query(
    `SELECT id, user_id, username, proxy_url, session_data, platform_state
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

async function generate({ userId, sessionId, seed = null }) {
  const session = await _session({ userId, sessionId });
  // Forces the in-memory client to regenerate from a new seed
  // (instagram-private-api uses a stable hash of the seed string for
  // device id, advertiser id, phone id, uuid).
  const newSeed = seed || `${session.username}_${randomUUID()}`;
  igClient.releaseClient(session.id);
  const client = await igClient.getClient(session);
  client.state.generateDevice(newSeed);
  // Persist the new fingerprint back to platform_state
  const ps = session.platform_state || {};
  ps.fingerprint = {
    seed: newSeed,
    deviceId: client.state.deviceId,
    uuid: client.state.uuid,
    phoneId: client.state.phoneId,
    adid: client.state.adid,
    build: client.state.build,
    rotated_at: new Date().toISOString(),
  };
  await pool.query(
    `UPDATE sessions SET platform_state = $1::jsonb, updated_at = NOW() WHERE id = $2`,
    [JSON.stringify(ps), session.id]
  );
  logger.info(`IG.identity.generate session=${session.id} seed=${newSeed}`);
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
  ps.fingerprint = { ...fingerprint, assigned_at: new Date().toISOString() };
  await pool.query(
    `UPDATE sessions SET platform_state = $1::jsonb, updated_at = NOW() WHERE id = $2`,
    [JSON.stringify(ps), session.id]
  );
  return ps.fingerprint;
}

module.exports = {
  generate,
  generateIdentity: generate,
  list,
  listIdentities: list,
  assign,
  assignIdentity: assign,
};
