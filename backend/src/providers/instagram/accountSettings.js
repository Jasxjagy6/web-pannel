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
const sessionLimiter = require('./sessionLimiter');
const riskScore = require('./riskScore');
const logger = require('../../utils/logger');
const { igFetch, sessionContext } = require('./igFetch');

// Phase 2.B12 — high-risk action gating.
// Hard limits to keep new / freshly-rotated accounts out of trouble.
const _RENAME_MIN_AGE_DAYS = 30;            // username rename requires aged account
const _RENAME_COOLDOWN_DAYS = 60;           // and at least 60 days since last rename
const _PROFILE_TEXT_COOLDOWN_DAYS = 7;      // bio/full_name change ≥ once per week
const _PFP_COOLDOWN_DAYS = 7;               // PFP change ≥ once per week

function _accountAgeDays(session) {
  if (!session.created_at) return null;
  return (Date.now() - new Date(session.created_at).getTime()) / 86400000;
}

function _daysSince(iso) {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 86400000;
}

async function _gateUsernameRename(session, override = false) {
  if (override) return;
  const age = _accountAgeDays(session);
  if (age != null && age < _RENAME_MIN_AGE_DAYS) {
    const e = new Error(
      `Username rename refused: account age ${age.toFixed(1)}d < required ${_RENAME_MIN_AGE_DAYS}d. ` +
      `Renaming a young account is one of the strongest automated-account flags Instagram tracks.`
    );
    e.statusCode = 403;
    e.code = 'AGED_SESSION_REQUIRED';
    throw e;
  }
  const ps = session.platform_state || {};
  const lastRename = ps.cooldowns && ps.cooldowns.last_username_rename_at;
  const sinceLast = _daysSince(lastRename);
  if (sinceLast < _RENAME_COOLDOWN_DAYS) {
    const e = new Error(
      `Username rename refused: ${sinceLast.toFixed(1)}d since last rename < cooldown ${_RENAME_COOLDOWN_DAYS}d.`
    );
    e.statusCode = 429;
    e.code = 'RENAME_COOLDOWN';
    throw e;
  }
}

async function _gateProfileTextEdit(session, override = false) {
  if (override) return;
  const ps = session.platform_state || {};
  const last = ps.cooldowns && ps.cooldowns.last_profile_text_edit_at;
  const sinceLast = _daysSince(last);
  if (sinceLast < _PROFILE_TEXT_COOLDOWN_DAYS) {
    const e = new Error(
      `Profile text edit refused: ${sinceLast.toFixed(1)}d since last edit < cooldown ${_PROFILE_TEXT_COOLDOWN_DAYS}d.`
    );
    e.statusCode = 429;
    e.code = 'PROFILE_TEXT_COOLDOWN';
    throw e;
  }
}

async function _gatePfpChange(session, override = false) {
  if (override) return;
  const ps = session.platform_state || {};
  const last = ps.cooldowns && ps.cooldowns.last_pfp_change_at;
  const sinceLast = _daysSince(last);
  if (sinceLast < _PFP_COOLDOWN_DAYS) {
    const e = new Error(
      `Profile-picture change refused: ${sinceLast.toFixed(1)}d since last change < cooldown ${_PFP_COOLDOWN_DAYS}d.`
    );
    e.statusCode = 429;
    e.code = 'PFP_COOLDOWN';
    throw e;
  }
}

async function _stampCooldown(sessionId, key) {
  try {
    const r = await pool.query(`SELECT platform_state FROM sessions WHERE id = $1`, [sessionId]);
    const ps = (r.rows[0] && r.rows[0].platform_state) || {};
    ps.cooldowns = Object.assign({}, ps.cooldowns, { [key]: new Date().toISOString() });
    await pool.query(
      `UPDATE sessions SET platform_state = $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(ps), sessionId]
    );
  } catch (err) {
    logger.warn(`IG.accountSettings: failed to stamp cooldown ${key} for session ${sessionId}: ${err.message}`);
  }
}

/**
 * Phase 1.B5 helper — returns the api_mode of a session ('mobile' or 'web').
 * Cookie-uploaded sessions are 'web' and use the web-API path
 * (igFetch against www.instagram.com); interactive-login sessions
 * are 'mobile' and use the IgApiClient private API.
 */
function _apiMode(session) {
  return (
    (session.platform_state && session.platform_state.api_mode) ||
    ((session.platform_state && session.platform_state.source === 'browser_cookies')
      ? 'web' : 'mobile')
  );
}

function _assertMobileApi(session) {
  if (_apiMode(session) !== 'mobile') {
    const e = new Error(
      'This action is only supported on interactive-login (mobile-API) sessions. ' +
      'Cookie-uploaded sessions must use the web-API path, which is enabled where supported.'
    );
    e.statusCode = 400;
    e.code = 'API_MODE_REFUSED';
    throw e;
  }
}

/**
 * Profile edit on a cookie-uploaded (web) session.
 * Posts the form fields to /api/v1/web/accounts/edit/ — the same
 * endpoint the IG web client uses behind the Settings page.
 */
async function _updateViaWeb({ session, patch, override }) {
  const ctx = await sessionContext(session);
  const out = { api_mode: 'web' };

  // The web edit endpoint requires every form field at once; fetch
  // the current values first and merge the patch in on top.
  let current = {};
  try {
    const r = await igFetch(
      ctx,
      'https://www.instagram.com/api/v1/accounts/edit/web_form_data/',
      { method: 'GET', referer: 'https://www.instagram.com/accounts/edit/' }
    );
    current = (r && r.form_data) || {};
  } catch (err) {
    out.read_error = err.message;
  }

  if (patch.username && patch.username !== current.username) {
    try {
      await _gateUsernameRename(session, override);
      await sessionLimiter.acquire(session.id, { class: 'risky' });
    } catch (err) {
      out.username_error = err.message;
      if (err.code) out.username_error_code = err.code;
    }
  }

  const willEditText =
    patch.full_name !== undefined ||
    patch.biography !== undefined ||
    patch.phone_number !== undefined ||
    patch.email !== undefined ||
    patch.external_url !== undefined ||
    patch.gender !== undefined ||
    (patch.username && patch.username !== current.username);

  if (!willEditText) {
    out.no_op = true;
    return out;
  }

  try {
    if (
      patch.full_name !== undefined ||
      patch.biography !== undefined ||
      patch.phone_number !== undefined ||
      patch.email !== undefined ||
      patch.external_url !== undefined ||
      patch.gender !== undefined
    ) {
      await _gateProfileTextEdit(session, override);
    }
    await sessionLimiter.acquire(session.id, { class: 'risky' });

    const merged = {
      first_name:   patch.full_name    !== undefined ? String(patch.full_name)    : (current.first_name   || ''),
      email:        patch.email        !== undefined ? String(patch.email)        : (current.email        || ''),
      username:     patch.username     !== undefined ? String(patch.username)     : (current.username     || ''),
      phone_number: patch.phone_number !== undefined ? String(patch.phone_number) : (current.phone_number || ''),
      gender:       patch.gender       !== undefined ? String(patch.gender)       : (current.gender       || '1'),
      biography:    patch.biography    !== undefined ? String(patch.biography)    : (current.biography    || ''),
      external_url: patch.external_url !== undefined ? String(patch.external_url) : (current.external_url || ''),
      chaining_enabled: 'on',
    };
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) form.append(k, v ?? '');

    const r = await igFetch(
      ctx,
      'https://www.instagram.com/api/v1/web/accounts/edit/',
      {
        method: 'POST',
        body: form.toString(),
        referer: 'https://www.instagram.com/accounts/edit/',
        limiterClass: 'risky',
        extraHeaders: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-instagram-ajax': '1',
        },
      }
    );
    out.profile = r || { ok: true };
    if (patch.username && patch.username !== current.username) {
      await _stampCooldown(session.id, 'last_username_rename_at');
    }
    await _stampCooldown(session.id, 'last_profile_text_edit_at');
  } catch (err) {
    out.profile_error = err.message;
    if (err.code) out.profile_error_code = err.code;
  }

  if (patch.profile_picture_buffer || patch.profile_picture_path) {
    out.profile_picture_error =
      'Profile picture upload via web cookies is not supported. ' +
      'Use an interactive-login (mobile-API) session for PFP changes.';
    out.profile_picture_error_code = 'WEB_PFP_UNSUPPORTED';
  }

  return out;
}

async function _session({ userId, sessionId }) {
  const r = await pool.query(
    `SELECT id, user_id, username, proxy_url, session_data, platform_state, created_at
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
  await sessionLimiter.acquire(session.id, { class: 'read' });

  if (_apiMode(session) === 'mobile') {
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
      api_mode: 'mobile',
    };
  }

  // Cookie / web-API session — use the web settings endpoint.
  // GET https://www.instagram.com/api/v1/accounts/edit/web_form_data/
  // returns { form_data: { username, first_name, biography, external_url,
  // email, phone_number, gender, country_code, profile_pic_url,
  // is_private }, ... } for the logged-in user.
  const ctx = await sessionContext(session);
  let payload;
  try {
    payload = await igFetch(
      ctx,
      'https://www.instagram.com/api/v1/accounts/edit/web_form_data/',
      { method: 'GET', referer: 'https://www.instagram.com/accounts/edit/' }
    );
  } catch (err) {
    // Fall back to the public web_profile_info endpoint if the edit
    // endpoint refuses (some IG cookie sessions are read-only).
    if (!session.username) throw err;
    const res = await igFetch(
      ctx,
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(session.username)}`,
      {
        method: 'GET',
        referer: `https://www.instagram.com/${encodeURIComponent(session.username)}/`,
      }
    );
    const u = (res && res.data && res.data.user) || {};
    return {
      pk: u.id || null,
      username: u.username || session.username,
      full_name: u.full_name || '',
      biography: u.biography || '',
      profile_pic_url: u.profile_pic_url_hd || u.profile_pic_url || '',
      is_private: !!u.is_private,
      is_verified: !!u.is_verified,
      external_url: u.external_url || '',
      api_mode: 'web',
    };
  }

  const fd = (payload && payload.form_data) || {};
  return {
    pk: fd.pk || null,
    username: fd.username || session.username || '',
    full_name: fd.first_name || fd.full_name || '',
    biography: fd.biography || '',
    profile_pic_url: fd.profile_pic_url || '',
    is_private: !!fd.is_private,
    is_verified: false,
    external_url: fd.external_url || '',
    email: fd.email || '',
    phone_number: fd.phone_number || '',
    gender: fd.gender || '',
    api_mode: 'web',
  };
}

async function update({ userId, sessionId, patch = {} }) {
  const session = await _session({ userId, sessionId });

  // Phase 2.B12 — admin override flag. Operators that explicitly
  // need to bypass the cooldowns can pass `_admin_override:true` in
  // the patch (typically used for de-anonymising a corrupted account).
  const override = patch._admin_override === true;

  // Phase 3.B16 — refuse profile edits on a session whose risk score
  // is above the deny threshold. Profile edits are exactly the
  // category of action IG monitors most aggressively for newly-warmed
  // bot accounts; running them on a flagged session is a fast track
  // to a hard ban.
  if (!override) {
    await riskScore.gateOnRisk({ id: session.id });
  }

  // Cookie / web-API session — POST /api/v1/web/accounts/edit/
  if (_apiMode(session) !== 'mobile') {
    return _updateViaWeb({ session, patch, override });
  }

  const client = await igClient.getClient(session);
  const out = {};
  if (patch.username) {
    try {
      // Phase 2.B12 — reject if account is too young or recently renamed.
      await _gateUsernameRename(session, override);
      // Phase 1.B7 — risky-class token before the call.
      await sessionLimiter.acquire(session.id, { class: 'risky' });
      out.username = await client.account.editProfileUsername(String(patch.username));
      await _stampCooldown(session.id, 'last_username_rename_at');
    } catch (err) {
      out.username_error = err.message;
      if (err.code) out.username_error_code = err.code;
    }
  }
  // editProfile handles full_name / biography / phone / email / external_url / gender
  if (patch.full_name !== undefined || patch.biography !== undefined ||
      patch.phone_number !== undefined || patch.email !== undefined ||
      patch.external_url !== undefined || patch.gender !== undefined) {
    try {
      // Phase 2.B12 — 7-day cooldown on profile-text edits.
      await _gateProfileTextEdit(session, override);
      // Phase 1.B7 — risky-class token; profile-edit changes the
      // account in a way IG actively monitors for bot behaviour.
      await sessionLimiter.acquire(session.id, { class: 'risky' });
      const ep = await client.account.editProfile({
        full_name:    patch.full_name,
        biography:    patch.biography,
        phone_number: patch.phone_number,
        email:        patch.email,
        external_url: patch.external_url,
        gender:       patch.gender,
      });
      out.profile = ep;
      await _stampCooldown(session.id, 'last_profile_text_edit_at');
    } catch (err) {
      out.profile_error = err.message;
      if (err.code) out.profile_error_code = err.code;
    }
  }
  // Profile picture upload requires raw image bytes
  if (patch.profile_picture_buffer || patch.profile_picture_path) {
    try {
      // Phase 2.B12 — 7-day cooldown on PFP changes.
      await _gatePfpChange(session, override);
      // Phase 1.B7 — risky-class token before the call.
      await sessionLimiter.acquire(session.id, { class: 'risky' });
      const buf = patch.profile_picture_buffer ||
        require('fs').readFileSync(patch.profile_picture_path);
      out.profile_picture = await client.account.changeProfilePicture(buf);
      await _stampCooldown(session.id, 'last_pfp_change_at');
    } catch (err) {
      out.profile_picture_error = err.message;
      if (err.code) out.profile_picture_error_code = err.code;
    }
  }
  logger.info(`IG.accountSettings.update user=${userId} session=${sessionId} keys=${Object.keys(patch).join(',')}`);
  return out;
}

module.exports = {
  get,
  update,
};
