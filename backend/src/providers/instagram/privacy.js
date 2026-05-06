/**
 * Instagram privacy (provider.privacy.*).
 *
 * Sets the public/private flag (account.setAccountPrivate / setAccountPublic).
 * Per architecture §6.7, story / message-receipt controls are surfaced too.
 *
 * Cookie-uploaded (web-API) sessions read/set privacy via the
 * https://www.instagram.com/api/v1/web/accounts/set_private/ +
 * /set_public/ endpoints, fed through igFetch with the session's
 * pinned web fingerprint and CSRF token.
 */

const { pool } = require('../../config/database');
const igClient = require('./client');
const logger = require('../../utils/logger');
const { igFetch, sessionContext } = require('./igFetch');

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

function _apiMode(session) {
  return (
    (session.platform_state && session.platform_state.api_mode) ||
    ((session.platform_state && session.platform_state.source === 'browser_cookies')
      ? 'web' : 'mobile')
  );
}

async function get({ userId, sessionId }) {
  const session = await _session({ userId, sessionId });

  if (_apiMode(session) === 'mobile') {
    const client = await igClient.getClient(session);
    const me = await client.account.currentUser();
    return {
      is_private: !!me.is_private,
      has_anonymous_profile_picture: !!me.has_anonymous_profile_picture,
      api_mode: 'mobile',
    };
  }

  // Web-API path — read is_private from the public web_profile_info,
  // which works on cookie sessions without tripping checkpoint.
  const ctx = await sessionContext(session);
  const u = encodeURIComponent(String(session.username || '').replace(/^@/, '').toLowerCase());
  const res = await igFetch(
    ctx,
    `https://www.instagram.com/api/v1/users/web_profile_info/?username=${u}`,
    {
      method: 'GET',
      referer: `https://www.instagram.com/${u}/`,
    }
  );
  const user = (res && res.data && res.data.user) || {};
  return {
    is_private: !!user.is_private,
    has_anonymous_profile_picture: !!user.has_anonymous_profile_picture,
    api_mode: 'web',
  };
}

async function setPrivacy({ userId, sessionId, settings = {} }) {
  const session = await _session({ userId, sessionId });

  if (_apiMode(session) === 'mobile') {
    const client = await igClient.getClient(session);
    const out = { api_mode: 'mobile' };
    if (settings.is_private === true) {
      out.set_private = await client.account.setAccountPrivate();
    } else if (settings.is_private === false) {
      out.set_public = await client.account.setAccountPublic();
    }
    logger.info(`IG.privacy.set user=${userId} session=${sessionId} settings=${JSON.stringify(settings)}`);
    return out;
  }

  // Web-API path
  const ctx = await sessionContext(session);
  const out = { api_mode: 'web' };
  const targetUrl = settings.is_private === true
    ? 'https://www.instagram.com/api/v1/web/accounts/set_private/'
    : settings.is_private === false
      ? 'https://www.instagram.com/api/v1/web/accounts/set_public/'
      : null;
  if (!targetUrl) {
    return { ...out, no_op: true };
  }
  const r = await igFetch(ctx, targetUrl, {
    method: 'POST',
    body: '',
    referer: 'https://www.instagram.com/accounts/privacy_and_security/',
    limiterClass: 'risky',
    extraHeaders: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-instagram-ajax': '1',
    },
  });
  out.result = r || { ok: true };
  logger.info(`IG.privacy.set (web) user=${userId} session=${sessionId} settings=${JSON.stringify(settings)}`);
  return out;
}

module.exports = {
  get,
  set: setPrivacy,
  setPrivacy,
};
