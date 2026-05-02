/**
 * Instagram client pool — analog of TelegramService for Instagram.
 *
 * Owns a Map<sessionId, IgApiClient> keyed by the per-row session id,
 * exposes `getClient(session)` / `releaseClient(sessionId)` so the per-
 * feature subsystems (scrape, messaging, threads, ...) reuse a logged-in
 * client across operations.
 *
 * IgApiClient already supports passing an external state via the
 * `state.deserialize(...)` API; we persist that JSON blob in the
 * sessions.session_data column (encrypted) so reboots don't have to log
 * the user back in. The device fingerprint lives separately in
 * sessions.platform_state.device so it stays stable across re-logins.
 */

const logger = require('../../utils/logger');
const { encrypt, decrypt } = require('../../utils/crypto');
const { pool } = require('../../config/database');

let _IgApiClient = null;
let _IgCheckpointError = null;
let _IgLoginTwoFactorRequiredError = null;

function _loadIgRuntime() {
  if (_IgApiClient) return;
  // eslint-disable-next-line global-require
  const ig = require('instagram-private-api');
  _IgApiClient = ig.IgApiClient;
  _IgCheckpointError = ig.IgCheckpointError;
  _IgLoginTwoFactorRequiredError = ig.IgLoginTwoFactorRequiredError;
}

const _clientPool = new Map(); // sessionId -> { client, state, lastUsed, lockedBy }

function _now() { return Date.now(); }

/**
 * Return (or create) an IgApiClient for a given session row.
 *
 *   await provider.client.getClient(session) → IgApiClient
 *
 * If the session has stored state (`session_data` encrypted JSON), it is
 * deserialised and the client is returned without a new login. Otherwise
 * the caller is expected to call `client.account.login(...)` themselves.
 */
async function getClient(session) {
  _loadIgRuntime();
  if (!session || !session.id) {
    throw new Error('getClient(): session row required');
  }

  const cached = _clientPool.get(session.id);
  if (cached && cached.client) {
    cached.lastUsed = _now();
    return cached.client;
  }

  const client = new _IgApiClient();
  // Stable device generation per session.username so reconnects don't
  // reroll the fingerprint.
  client.state.generateDevice(session.username || `ig_${session.id}`);

  // Optional proxy
  if (session.proxy_url) {
    client.state.proxyUrl = session.proxy_url;
  }

  // Restore previous state (cookies, ua, device blob) if we have it.
  if (session.session_data) {
    try {
      const decrypted = decrypt(session.session_data);
      const blob = JSON.parse(decrypted);
      if (blob && blob.cookies) {
        await client.state.deserializeCookieJar(JSON.stringify(blob.cookies));
      }
      if (blob && blob.deviceString) client.state.deviceString = blob.deviceString;
      if (blob && blob.deviceId) client.state.deviceId = blob.deviceId;
      if (blob && blob.uuid) client.state.uuid = blob.uuid;
      if (blob && blob.phoneId) client.state.phoneId = blob.phoneId;
      if (blob && blob.adid) client.state.adid = blob.adid;
      if (blob && blob.build) client.state.build = blob.build;
    } catch (err) {
      logger.warn(`IG.getClient: failed to restore session state for sessionId=${session.id}: ${err.message}`);
    }
  }

  _clientPool.set(session.id, {
    client,
    lastUsed: _now(),
  });
  return client;
}

/**
 * Persist the client state (cookies + device fingerprint) back to the DB
 * so the next process boot can reconnect without a fresh login.
 */
async function persistClientState(sessionId, client) {
  if (!client) return;
  const cookies = JSON.parse(await client.state.serializeCookieJar());
  const blob = {
    cookies,
    deviceString: client.state.deviceString,
    deviceId: client.state.deviceId,
    uuid: client.state.uuid,
    phoneId: client.state.phoneId,
    adid: client.state.adid,
    build: client.state.build,
  };
  const encrypted = encrypt(JSON.stringify(blob));
  await pool.query(
    `UPDATE sessions
        SET session_data = $1,
            updated_at = NOW()
      WHERE id = $2`,
    [encrypted, sessionId]
  );
}

/**
 * Forget a client (logout / explicit eviction).
 */
function releaseClient(sessionId) {
  _clientPool.delete(sessionId);
}

/**
 * For unit tests / admin tools.
 */
function poolSize() {
  return _clientPool.size;
}

/**
 * Best-effort ping. Used by sessions.heartbeat to mark expired/invalid
 * sessions in the DB.
 */
async function ping(client) {
  try {
    const me = await client.account.currentUser();
    return { ok: true, user: { pk: me.pk, username: me.username, full_name: me.full_name } };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Type-guard re-exports so subsystems can do
 *   if (err instanceof igClient.IgCheckpointError) { ... }
 */
function isCheckpointError(err) {
  _loadIgRuntime();
  return err instanceof _IgCheckpointError;
}
function isTwoFactorError(err) {
  _loadIgRuntime();
  return err instanceof _IgLoginTwoFactorRequiredError;
}

module.exports = {
  getClient,
  persistClientState,
  releaseClient,
  poolSize,
  ping,
  isCheckpointError,
  isTwoFactorError,
};
