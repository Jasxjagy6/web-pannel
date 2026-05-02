/**
 * Instagram accountSettings (provider.accountSettings.*).
 *
 * Update profile fields:
 *   - username  (rename via account.editProfileUsername)
 *   - full_name (account.editProfile)
 *   - biography (account.editProfile)
 *   - profile_picture (account.changeProfilePicture)
 *
 * The TG analog only handles first_name / last_name / bio / username and
 * sets a profile photo via the TG MTProto. IG has the same surface but
 * via the private API.
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
    pk: me.pk,
    username: me.username,
    full_name: me.full_name,
    biography: me.biography,
    profile_pic_url: me.profile_pic_url,
    is_private: me.is_private,
    is_verified: me.is_verified,
  };
}

async function update({ userId, sessionId, patch = {} }) {
  const session = await _session({ userId, sessionId });
  const client = await igClient.getClient(session);
  const out = {};
  if (patch.username) {
    try {
      out.username = await client.account.editProfileUsername(String(patch.username));
    } catch (err) {
      out.username_error = err.message;
    }
  }
  // editProfile handles full_name / biography / phone / email / external_url / gender
  if (patch.full_name !== undefined || patch.biography !== undefined ||
      patch.phone_number !== undefined || patch.email !== undefined ||
      patch.external_url !== undefined || patch.gender !== undefined) {
    try {
      const ep = await client.account.editProfile({
        full_name:    patch.full_name,
        biography:    patch.biography,
        phone_number: patch.phone_number,
        email:        patch.email,
        external_url: patch.external_url,
        gender:       patch.gender,
      });
      out.profile = ep;
    } catch (err) {
      out.profile_error = err.message;
    }
  }
  // Profile picture upload requires raw image bytes
  if (patch.profile_picture_buffer || patch.profile_picture_path) {
    try {
      const buf = patch.profile_picture_buffer ||
        require('fs').readFileSync(patch.profile_picture_path);
      out.profile_picture = await client.account.changeProfilePicture(buf);
    } catch (err) {
      out.profile_picture_error = err.message;
    }
  }
  logger.info(`IG.accountSettings.update user=${userId} session=${sessionId} keys=${Object.keys(patch).join(',')}`);
  return out;
}

module.exports = {
  get,
  update,
};
