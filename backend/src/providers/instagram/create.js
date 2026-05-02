/**
 * Instagram interactive session creation flow.
 *
 * The flow is a 3-step state machine that matches the TG sessionCreation
 * shape so the controllers/UI can be platform-agnostic:
 *
 *   POST /api/instagram/sessions/create/start
 *     body: { username, password, proxyUrl? }
 *     → { sessionToken, requires: 'password'|'2fa'|'challenge', meta }
 *
 *   POST /api/instagram/sessions/create/password   (2FA TOTP)
 *     body: { sessionToken, code }
 *     → { sessionId } | { requires: 'challenge', meta }
 *
 *   POST /api/instagram/sessions/create/verify     (challenge SMS / email code)
 *     body: { sessionToken, code }
 *     → { sessionId } | { requires: '2fa', meta }
 *
 *   POST /api/instagram/sessions/create/cancel     (drop session token)
 *     body: { sessionToken }
 *
 *   POST /api/instagram/sessions/create/resend     (request a new challenge)
 *     body: { sessionToken }
 *
 * In-flight state lives in process memory keyed by sessionToken. Tokens
 * expire after 15 minutes of inactivity. ig_challenges rows are written
 * to the DB so admins can inspect open challenges.
 */

const crypto = require('crypto');
const { pool } = require('../../config/database');
const logger = require('../../utils/logger');
const igClient = require('./client');
const { registerSession } = require('./sessions');

const PENDING_TOKEN_TTL_MS = 15 * 60 * 1000;

// In-process state. Pod-affinity is required if the pool ever scales
// horizontally — see OPS.md "create flow stickiness".
const _pending = new Map();

function _newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function _expirePendings() {
  const now = Date.now();
  for (const [token, ent] of _pending) {
    if (ent.expiresAt < now) _pending.delete(token);
  }
}
setInterval(_expirePendings, 60 * 1000).unref();

async function _putChallenge({ userId, username, challengeUrl, twoFactorIdentifier, state }) {
  const result = await pool.query(
    `INSERT INTO ig_challenges
       (user_id, username, challenge_url, challenge_type, two_factor_identifier, state)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING id`,
    [
      userId,
      username,
      challengeUrl || '',
      state?.challengeType || null,
      twoFactorIdentifier || null,
      JSON.stringify(state || {}),
    ]
  );
  return result.rows[0].id;
}

async function _resolveChallenge(challengeId) {
  await pool.query(`UPDATE ig_challenges SET resolved = TRUE WHERE id = $1`, [challengeId]);
}

/**
 * Begin a login. Tries username + password, branches into one of:
 *   - happy-path → sessionId
 *   - IgLoginTwoFactorRequiredError → requires: '2fa'
 *   - IgCheckpointError → requires: 'challenge'
 */
async function start({ userId, username, password, proxyUrl = null }) {
  if (!userId) throw new Error('userId required');
  if (!username) throw new Error('username required');
  if (!password) throw new Error('password required');

  // Build a fresh client; we don't reuse pool clients here because the
  // session row doesn't exist yet.
  // eslint-disable-next-line global-require
  const { IgApiClient, IgLoginTwoFactorRequiredError, IgCheckpointError } = require('instagram-private-api');
  const client = new IgApiClient();
  client.state.generateDevice(username.toLowerCase());
  if (proxyUrl) client.state.proxyUrl = proxyUrl;

  // Pre-login simulator (warms cookies). The README says this prevents
  // "challenge_required" on a fraction of new accounts.
  await client.simulate.preLoginFlow();

  const token = _newToken();
  const expiresAt = Date.now() + PENDING_TOKEN_TTL_MS;
  _pending.set(token, {
    userId,
    username: username.toLowerCase(),
    proxyUrl,
    client,
    twoFactorIdentifier: null,
    challengeId: null,
    stage: 'starting',
    expiresAt,
  });

  try {
    const me = await client.account.login(username, password);
    // Eager post-login simulation so the session looks human.
    await client.simulate.postLoginFlow();
    // Persist cookies + device fingerprint, register the session row.
    const cookieJson = JSON.parse(await client.state.serializeCookieJar());
    const blob = {
      cookies: cookieJson,
      deviceString: client.state.deviceString,
      deviceId: client.state.deviceId,
      uuid: client.state.uuid,
      phoneId: client.state.phoneId,
      adid: client.state.adid,
      build: client.state.build,
    };
    const row = await registerSession({
      userId,
      username,
      sessionBlob: blob,
      proxyUrl,
      platformState: { fingerprint: { deviceId: blob.deviceId, build: blob.build } },
    });
    _pending.delete(token);
    logger.info(`IG.create.start happy-path user=${userId} username=${username} sessionId=${row.id}`);
    return {
      sessionToken: null,
      sessionId: row.id,
      username: me.username,
      requires: null,
    };
  } catch (err) {
    if (err instanceof IgLoginTwoFactorRequiredError) {
      const info = err.response.body.two_factor_info;
      const twoFactorIdentifier = info.two_factor_identifier;
      _pending.set(token, {
        ..._pending.get(token),
        stage: 'awaiting_2fa',
        twoFactorIdentifier,
        username: info.username || username.toLowerCase(),
      });
      logger.info(`IG.create.start awaiting_2fa user=${userId} username=${username}`);
      return {
        sessionToken: token,
        requires: '2fa',
        meta: {
          method: info.totp_two_factor_on ? 'totp' : 'sms',
          obfuscated_phone_number: info.obfuscated_phone_number || null,
          two_factor_identifier: twoFactorIdentifier,
        },
      };
    }
    if (err instanceof IgCheckpointError) {
      const challengeId = await _putChallenge({
        userId,
        username,
        challengeUrl: err.checkpoint?.url || '',
        state: { stage: 'init' },
      });
      _pending.set(token, {
        ..._pending.get(token),
        stage: 'awaiting_challenge',
        challengeId,
      });
      logger.info(`IG.create.start awaiting_challenge user=${userId} username=${username} challengeId=${challengeId}`);
      return {
        sessionToken: token,
        requires: 'challenge',
        meta: {
          challengeId,
          challengeUrl: err.checkpoint?.url || null,
        },
      };
    }
    _pending.delete(token);
    logger.warn(`IG.create.start failed user=${userId} username=${username}: ${err.message}`);
    throw err;
  }
}

/**
 * Submit a TOTP / SMS-2FA code (the `requires: '2fa'` follow-up).
 * Same shape as the TG create flow's `password` step (cloud password).
 */
async function password({ sessionToken, code }) {
  if (!sessionToken) {
    const e = new Error('sessionToken required');
    e.statusCode = 400;
    throw e;
  }
  const ent = _pending.get(sessionToken);
  if (!ent) {
    const e = new Error('Session token expired or unknown');
    e.statusCode = 410;
    e.code = 'CREATE_SESSION_EXPIRED';
    throw e;
  }
  if (ent.stage !== 'awaiting_2fa') {
    const e = new Error(`Cannot submit 2FA from stage=${ent.stage}`);
    e.statusCode = 409;
    throw e;
  }
  try {
    const me = await ent.client.account.twoFactorLogin({
      username: ent.username,
      verificationCode: String(code).trim(),
      twoFactorIdentifier: ent.twoFactorIdentifier,
      verificationMethod: '1',
      trustThisDevice: '1',
    });
    await ent.client.simulate.postLoginFlow();
    const cookieJson = JSON.parse(await ent.client.state.serializeCookieJar());
    const blob = {
      cookies: cookieJson,
      deviceString: ent.client.state.deviceString,
      deviceId: ent.client.state.deviceId,
      uuid: ent.client.state.uuid,
      phoneId: ent.client.state.phoneId,
      adid: ent.client.state.adid,
      build: ent.client.state.build,
    };
    const row = await registerSession({
      userId: ent.userId,
      username: ent.username,
      sessionBlob: blob,
      proxyUrl: ent.proxyUrl,
      platformState: { fingerprint: { deviceId: blob.deviceId, build: blob.build } },
    });
    _pending.delete(sessionToken);
    logger.info(`IG.create.password ok user=${ent.userId} username=${ent.username} sessionId=${row.id}`);
    return { sessionId: row.id, username: me.username };
  } catch (err) {
    logger.warn(`IG.create.password failed user=${ent.userId}: ${err.message}`);
    throw err;
  }
}

/**
 * Submit a challenge code (SMS / email — `requires: 'challenge'` follow-up).
 *
 * This is the IG analog of the TG create-flow's verify step (phone code).
 */
async function verify({ sessionToken, code }) {
  if (!sessionToken) {
    const e = new Error('sessionToken required');
    e.statusCode = 400;
    throw e;
  }
  const ent = _pending.get(sessionToken);
  if (!ent) {
    const e = new Error('Session token expired or unknown');
    e.statusCode = 410;
    e.code = 'CREATE_SESSION_EXPIRED';
    throw e;
  }
  if (ent.stage !== 'awaiting_challenge') {
    const e = new Error(`Cannot submit challenge code from stage=${ent.stage}`);
    e.statusCode = 409;
    throw e;
  }
  try {
    // Fire `auto` first so IG picks the medium (SMS vs email) based on
    // the user's preference. Then submit the code.
    await ent.client.challenge.auto(true);
    const reply = await ent.client.challenge.sendSecurityCode(String(code).trim());
    if (ent.challengeId) await _resolveChallenge(ent.challengeId);

    // After a successful challenge, IG returns either logged_in_user
    // (we're done) or two_factor_required (now needs 2FA).
    if (reply && reply.logged_in_user) {
      await ent.client.simulate.postLoginFlow();
      const cookieJson = JSON.parse(await ent.client.state.serializeCookieJar());
      const blob = {
        cookies: cookieJson,
        deviceString: ent.client.state.deviceString,
        deviceId: ent.client.state.deviceId,
        uuid: ent.client.state.uuid,
        phoneId: ent.client.state.phoneId,
        adid: ent.client.state.adid,
        build: ent.client.state.build,
      };
      const row = await registerSession({
        userId: ent.userId,
        username: ent.username,
        sessionBlob: blob,
        proxyUrl: ent.proxyUrl,
        platformState: { fingerprint: { deviceId: blob.deviceId, build: blob.build } },
      });
      _pending.delete(sessionToken);
      logger.info(`IG.create.verify ok user=${ent.userId} username=${ent.username} sessionId=${row.id}`);
      return { sessionId: row.id, username: reply.logged_in_user.username };
    }

    if (reply && reply.two_factor_info) {
      _pending.set(sessionToken, {
        ...ent,
        stage: 'awaiting_2fa',
        twoFactorIdentifier: reply.two_factor_info.two_factor_identifier,
      });
      return {
        requires: '2fa',
        meta: {
          method: reply.two_factor_info.totp_two_factor_on ? 'totp' : 'sms',
          obfuscated_phone_number: reply.two_factor_info.obfuscated_phone_number || null,
        },
      };
    }
    return { ok: true };
  } catch (err) {
    logger.warn(`IG.create.verify failed user=${ent.userId}: ${err.message}`);
    throw err;
  }
}

/**
 * Ask IG to re-send the challenge code (SMS / email pick).
 */
async function resend({ sessionToken, method }) {
  const ent = _pending.get(sessionToken);
  if (!ent) {
    const e = new Error('Session token expired or unknown');
    e.statusCode = 410;
    e.code = 'CREATE_SESSION_EXPIRED';
    throw e;
  }
  if (ent.stage !== 'awaiting_challenge') {
    const e = new Error(`Cannot resend challenge from stage=${ent.stage}`);
    e.statusCode = 409;
    throw e;
  }
  // method: 0 = SMS, 1 = email
  const choice = method === 'email' ? 1 : 0;
  try {
    await ent.client.challenge.selectVerifyMethod(choice);
    return { ok: true };
  } catch (err) {
    logger.warn(`IG.create.resend failed user=${ent.userId}: ${err.message}`);
    throw err;
  }
}

async function cancel({ sessionToken }) {
  const ent = _pending.get(sessionToken);
  if (ent && ent.challengeId) {
    await _resolveChallenge(ent.challengeId).catch(() => {});
  }
  _pending.delete(sessionToken);
  return { ok: true };
}

module.exports = {
  start,
  password,
  verify,
  resend,
  cancel,
};
