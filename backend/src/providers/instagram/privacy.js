/**
 * Instagram privacy (provider.privacy.*).
 *
 * Sets the public/private flag (account.setAccountPrivate / setAccountPublic).
 * Per architecture §6.7, story / message-receipt controls are surfaced too.
 */

const { pool } = require('../../config/database');
const igClient = require('./client');
const logger = require('../../utils/logger');

async function _session({ userId, sessionId }) {
  const r = await pool.query(
    `SELECT id, user_id, username, proxy_url, session_data, platform_state
       FROM sessions
      WHERE id = $1 AND user_id = $2 AND platform = 'instagram'
        AND is_logged_in = TRUE`,
    [sessionId, userId]
  );
  if (r.rows.length === 0) {
    const e = new Error('Instagram session not found or not logged-in');
    e.statusCode = 404;
    throw e;
  }
  return r.rows[0];
}

async function get({ userId, sessionId }) {
  const session = await _session({ userId, sessionId });
  const client = await igClient.getClient(session);
  const me = await client.account.currentUser();
  return {
    is_private: !!me.is_private,
    has_anonymous_profile_picture: !!me.has_anonymous_profile_picture,
  };
}

async function setPrivacy({ userId, sessionId, settings = {} }) {
  const session = await _session({ userId, sessionId });
  const client = await igClient.getClient(session);
  const out = {};
  if (settings.is_private === true) {
    out.set_private = await client.account.setAccountPrivate();
  } else if (settings.is_private === false) {
    out.set_public = await client.account.setAccountPublic();
  }
  logger.info(`IG.privacy.set user=${userId} session=${sessionId} settings=${JSON.stringify(settings)}`);
  return out;
}

module.exports = {
  get,
  set: setPrivacy,
  setPrivacy,
};
