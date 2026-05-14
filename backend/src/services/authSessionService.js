/**
 * Auth-session bookkeeping.
 *
 * Each JWT issued by the panel carries a random jti (UUID). When the JWT
 * is signed we INSERT a row into `auth_sessions`; on every authenticated
 * request the middleware looks the jti up and bumps `last_seen_at`. This
 * gives us three capabilities that stateless JWTs cannot:
 *
 *   - Per-session revocation (logout one device).
 *   - Blanket revocation when ADMIN_EMAIL / ADMIN_PASSWORD rotate in
 *     backend/.env (kill every still-open browser session for the admin
 *     so anybody currently logged in with the old credentials gets kicked
 *     to /login the next time they make an API call).
 *   - The "Active logins" view in the admin panel.
 *
 * See migration_v33_auth_sessions.sql for the schema. The `revoked_at`
 * timestamp is the single source of truth — once it's set, the JWT is
 * dead even if it still has time left on its `exp`.
 */
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../config/database');

const MAX_USER_AGENT_LEN = 512;

function _clientIp(req) {
  if (!req) return null;
  // Express's `req.ip` already honors the `trust proxy` setting (see
  // backend/src/index.js: `app.set('trust proxy', 1)` for nginx). Fall
  // back to the socket address for the smoke-test harness which calls
  // these helpers without a real req.
  const ip = req.ip || req.connection?.remoteAddress || null;
  if (!ip) return null;
  return String(ip).slice(0, 64);
}

function _userAgent(req) {
  if (!req) return null;
  const ua = req.headers?.['user-agent'];
  if (!ua) return null;
  return String(ua).slice(0, MAX_USER_AGENT_LEN);
}

function _expiryFromJwtExpire(expireSetting) {
  // process.env.JWT_EXPIRE is consumed by jsonwebtoken's `expiresIn`
  // option, but the auth_sessions row also needs an explicit expiry so
  // the admin UI can show "expires in N days". Parse a handful of common
  // values; default to 7 days (same as the env default).
  const raw = String(expireSetting || '7d').trim();
  const m = /^(\d+)\s*([smhdw]?)$/i.exec(raw);
  if (!m) return new Date(Date.now() + 7 * 24 * 3600 * 1000);
  const n = parseInt(m[1], 10);
  const unit = (m[2] || 's').toLowerCase();
  const mult = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[unit] || 1;
  return new Date(Date.now() + n * mult * 1000);
}

/**
 * Insert a fresh auth_sessions row for `userId` and return its jti +
 * server-assigned timestamps. Call this once per JWT signing.
 *
 * The jti returned MUST be embedded into the JWT payload (claim name
 * `jti`) so the auth middleware can resolve the session row on each
 * subsequent request.
 */
async function createSession(userId, req, { reason = null } = {}) {
  const jti = uuidv4();
  const ip = _clientIp(req);
  const ua = _userAgent(req);
  const expiresAt = _expiryFromJwtExpire(process.env.JWT_EXPIRE);

  const result = await pool.query(
    `INSERT INTO auth_sessions (user_id, jti, ip_address, user_agent,
                                issued_at, last_seen_at, expires_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW(), $5)
     RETURNING id, jti, issued_at, last_seen_at, expires_at`,
    [userId, jti, ip, ua, expiresAt]
  );
  return result.rows[0];
}

/**
 * Look up the active auth_sessions row for the given jti. Returns null
 * if the row doesn't exist or has been revoked.
 */
async function getActiveByJti(jti) {
  if (!jti) return null;
  const r = await pool.query(
    `SELECT id, user_id, jti, ip_address, user_agent,
            issued_at, last_seen_at, expires_at, revoked_at, revoked_reason
       FROM auth_sessions
      WHERE jti = $1
        AND revoked_at IS NULL`,
    [jti]
  );
  return r.rows[0] || null;
}

/**
 * Bump last_seen_at to NOW() (and refresh IP / user-agent if they
 * changed). Called from the auth middleware on every authenticated
 * request, fire-and-forget — a failure here must not block the request.
 */
async function touchSession(sessionId, req) {
  if (!sessionId) return;
  const ip = _clientIp(req);
  const ua = _userAgent(req);
  try {
    await pool.query(
      `UPDATE auth_sessions
          SET last_seen_at = NOW(),
              ip_address   = COALESCE($2, ip_address),
              user_agent   = COALESCE($3, user_agent)
        WHERE id = $1
          AND revoked_at IS NULL`,
      [sessionId, ip, ua]
    );
  } catch (_) {
    // Swallow — touch is best-effort and we don't want a DB blip to
    // 500 an otherwise-valid authenticated request.
  }
}

/**
 * List active (non-revoked, non-expired) sessions for a single user,
 * ordered by most-recently-active first.
 */
async function listActiveForUser(userId) {
  const r = await pool.query(
    `SELECT id, user_id, jti, ip_address, user_agent,
            issued_at, last_seen_at, expires_at
       FROM auth_sessions
      WHERE user_id = $1
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY last_seen_at DESC`,
    [userId]
  );
  return r.rows;
}

/**
 * Revoke a single session by id. Returns the updated row, or null if it
 * was already revoked / didn't exist.
 *
 * `requireUserId` scopes the revocation: pass it when an admin is
 * revoking from the UI to make sure the session belongs to the user
 * they're viewing (defense in depth against an admin accidentally
 * passing the wrong id).
 */
async function revokeById(sessionId, reason, requireUserId = null) {
  const params = [sessionId, reason || 'admin_revoked'];
  let where = `id = $1 AND revoked_at IS NULL`;
  if (requireUserId !== null && requireUserId !== undefined) {
    params.push(requireUserId);
    where += ` AND user_id = $${params.length}`;
  }
  const r = await pool.query(
    `UPDATE auth_sessions
        SET revoked_at = NOW(),
            revoked_reason = $2
      WHERE ${where}
      RETURNING id, user_id, jti, revoked_at, revoked_reason`,
    params
  );
  return r.rows[0] || null;
}

/**
 * Revoke ALL active sessions for `userId`. Optionally exclude one
 * session id (`exceptSessionId`) so an admin can "log out everywhere
 * else" without killing the browser they're using right now. Returns
 * the number of rows updated.
 */
async function revokeAllForUser(userId, reason, { exceptSessionId = null } = {}) {
  const params = [userId, reason || 'mass_revoked'];
  let where = `user_id = $1 AND revoked_at IS NULL`;
  if (exceptSessionId) {
    params.push(exceptSessionId);
    where += ` AND id <> $${params.length}`;
  }
  const r = await pool.query(
    `UPDATE auth_sessions
        SET revoked_at = NOW(),
            revoked_reason = $2
      WHERE ${where}`,
    params
  );
  return r.rowCount;
}

/**
 * Convenience: revoke a session by its jti. Used by /api/auth/logout
 * where the controller only has the JWT, not the auth_sessions row id.
 */
async function revokeByJti(jti, reason) {
  if (!jti) return null;
  const r = await pool.query(
    `UPDATE auth_sessions
        SET revoked_at = NOW(),
            revoked_reason = $2
      WHERE jti = $1
        AND revoked_at IS NULL
      RETURNING id, user_id, jti, revoked_at`,
    [jti, reason || 'logout']
  );
  return r.rows[0] || null;
}

module.exports = {
  createSession,
  getActiveByJti,
  touchSession,
  listActiveForUser,
  revokeById,
  revokeByJti,
  revokeAllForUser,
  // Exposed for unit tests / the boot path's blanket invalidation step.
  _expiryFromJwtExpire,
};
