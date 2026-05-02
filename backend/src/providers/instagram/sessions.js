/**
 * Instagram sessions subsystem (provider.sessions.*).
 *
 * Handles list / get / delete / logout / status / download / heartbeat for
 * Instagram-platform sessions. The interactive create flow (login + 2FA +
 * challenge) lives in `./create.js`; this module covers everything else
 * after a session row exists.
 *
 * Schema notes:
 *   sessions.platform = 'instagram'
 *   sessions.username = IG username (lowercased)
 *   sessions.session_data = encrypted JSON: { cookies, deviceString, deviceId, uuid, phoneId, adid, build }
 *   sessions.platform_state = JSONB { warmup: {...}, fingerprint: {...}, ... }
 */

const { pool } = require('../../config/database');
const logger = require('../../utils/logger');
const { encrypt, decrypt } = require('../../utils/crypto');
const igClient = require('./client');
const cookieAdapter = require('./cookieAdapter');

const PLATFORM = 'instagram';

/**
 * Register an existing IG session in the DB. Used when a user uploads
 * a previously-serialised session blob (e.g. exported from another
 * tool). The interactive create flow at ./create.js takes a different
 * path that culminates in this same `registerSession()`.
 */
async function registerSession({ userId, username, sessionBlob, proxyUrl = null, platformState = {} }) {
  if (!userId) throw new Error('userId required');
  if (!username) throw new Error('username required');
  if (!sessionBlob) throw new Error('sessionBlob required');

  const enc = encrypt(typeof sessionBlob === 'string' ? sessionBlob : JSON.stringify(sessionBlob));

  const result = await pool.query(
    `INSERT INTO sessions
       (user_id, platform, username, session_string, session_data, proxy_url,
        is_logged_in, status, platform_state,
        created_at, updated_at)
     VALUES ($1, 'instagram', $2, NULL, $3, $4, TRUE, 'active', $5::jsonb, NOW(), NOW())
     RETURNING id, user_id, platform, username, status, is_logged_in, created_at`,
    [userId, username.toLowerCase(), enc, proxyUrl, JSON.stringify(platformState)]
  );

  logger.info(`IG.registerSession user=${userId} username=${username} sessionId=${result.rows[0].id}`);
  return result.rows[0];
}

/**
 * Bulk upload — accepts an array of `{ username, sessionBlob }` records
 * (exported from another panel). For interactive create, see ./create.js.
 */
async function upload(files, userId, options = {}) {
  // The IG provider doesn't accept binary `.session` files like Telegram
  // does; instead we expect a JSON file (one or more accounts) where each
  // record has { username, sessionBlob, proxyUrl? }.
  const startTime = Date.now();
  const results = [];
  let successful = 0;
  let failed = 0;

  for (const file of (files || [])) {
    try {
      const buf = file.buffer || (file.path ? require('fs').readFileSync(file.path) : null);
      if (!buf) throw new Error('Empty upload');
      const text = buf.toString('utf8');
      const parsedRaw = JSON.parse(text);

      // Browser-cookie export shape (Cookie-Editor / EditThisCookie /
      // Firefox JSON / { cookies: [...] }). Convert into a panel-shaped
      // record by spinning up a temp IG client to resolve the username.
      let parsed;
      if (cookieAdapter.looksLikeBrowserCookies(parsedRaw)) {
        const built = await cookieAdapter.buildSessionFromBrowserCookies(parsedRaw, {
          proxyUrl: options.proxyUrl || null,
        });
        parsed = [{
          username: built.username,
          sessionBlob: built.sessionBlob,
          proxyUrl: options.proxyUrl || null,
          platformState: built.platformState,
        }];
      } else {
        parsed = Array.isArray(parsedRaw) ? parsedRaw : [parsedRaw];
      }

      for (const rec of parsed) {
        if (!rec.username || !rec.sessionBlob) {
          throw new Error(`Invalid record: missing username or sessionBlob`);
        }
        const row = await registerSession({
          userId,
          username: rec.username,
          sessionBlob: rec.sessionBlob,
          proxyUrl: rec.proxyUrl || null,
          platformState: rec.platformState || {},
        });
        results.push({
          filename: file.originalname || file.name || 'upload.json',
          status: 'success',
          sessionId: row.id,
          username: row.username,
        });
        successful += 1;
      }
    } catch (err) {
      logger.warn(`IG.upload: ${err.message}`);
      results.push({
        filename: file.originalname || file.name || 'upload.json',
        status: 'error',
        error: err.message,
      });
      failed += 1;
    }
  }

  return {
    total: results.length,
    successful,
    failed,
    results,
    duration: Date.now() - startTime,
  };
}

async function listSessions(userId, opts = {}) {
  const {
    page = 1,
    limit = 20,
    sort = 'created_at',
    order = 'DESC',
    filter = {},
  } = opts;

  const allowedSort = new Set(['id', 'created_at', 'updated_at', 'username', 'status']);
  const sortCol = allowedSort.has(sort) ? sort : 'created_at';
  const sortDir = order && order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const where = ['user_id = $1', "platform = 'instagram'"];
  const params = [userId];
  let p = 2;
  if (filter.status) { where.push(`status = $${p++}`); params.push(filter.status); }
  if (filter.is_logged_in !== undefined) {
    where.push(`is_logged_in = $${p++}`);
    params.push(!!filter.is_logged_in);
  }
  if (filter.search) {
    where.push(`username ILIKE $${p++}`);
    params.push(`%${filter.search}%`);
  }

  const offset = Math.max(0, (page - 1) * limit);
  params.push(limit, offset);

  const sql = `
    SELECT id, user_id, platform, username, status, is_logged_in,
           proxy_url, last_login, last_used, created_at, updated_at,
           platform_state, warmup_state, last_warmup_at
      FROM sessions
     WHERE ${where.join(' AND ')}
     ORDER BY ${sortCol} ${sortDir}
     LIMIT $${p++} OFFSET $${p++}
  `;
  const countSql = `SELECT COUNT(*)::int AS n FROM sessions WHERE ${where.join(' AND ')}`;
  const [rows, count] = await Promise.all([
    pool.query(sql, params),
    pool.query(countSql, params.slice(0, params.length - 2)),
  ]);
  return {
    sessions: rows.rows,
    total: count.rows[0].n,
    page,
    limit,
  };
}

async function get(sessionId, userId) {
  const result = await pool.query(
    `SELECT id, user_id, platform, username, status, is_logged_in,
            proxy_url, last_login, last_used, platform_state,
            warmup_state, last_warmup_at,
            created_at, updated_at
       FROM sessions
      WHERE id = $1 AND user_id = $2 AND platform = 'instagram'`,
    [sessionId, userId]
  );
  return result.rows[0] || null;
}

async function deleteSession(sessionId, userId) {
  const session = await get(sessionId, userId);
  if (!session) {
    const e = new Error('Session not found');
    e.statusCode = 404;
    throw e;
  }
  igClient.releaseClient(sessionId);
  await pool.query(
    `DELETE FROM sessions WHERE id = $1 AND user_id = $2 AND platform = 'instagram'`,
    [sessionId, userId]
  );
  logger.info(`IG.delete session=${sessionId} user=${userId}`);
  return { id: sessionId, sessionId, deleted: true };
}

async function bulkDelete(sessionIds, userId) {
  const results = [];
  let successful = 0;
  let failed = 0;
  for (const id of sessionIds || []) {
    try {
      await deleteSession(id, userId);
      results.push({ sessionId: id, success: true });
      successful += 1;
    } catch (err) {
      results.push({ sessionId: id, success: false, error: err.message });
      failed += 1;
    }
  }
  return {
    total: results.length,
    successful,
    failed,
    results,
  };
}

/**
 * Re-attach a previously-uploaded IG session to the in-memory client
 * pool and confirm the cookies are still valid by pinging the
 * `accounts/current_user` endpoint. If the cookies have been
 * invalidated by Instagram (e.g. password change, checkpoint), the
 * row is marked status='expired' and the operator is told to
 * recreate the session via the Create Session wizard.
 */
async function login(sessionId, userId) {
  const session = await get(sessionId, userId);
  if (!session) {
    const e = new Error('Session not found');
    e.statusCode = 404;
    throw e;
  }
  const fullRow = await pool.query(
    `SELECT id, user_id, platform, username, proxy_url, session_data
       FROM sessions WHERE id = $1 AND user_id = $2 AND platform = 'instagram'`,
    [sessionId, userId]
  );
  const row = fullRow.rows[0];
  if (!row || !row.session_data) {
    const e = new Error(
      'No stored Instagram session blob — please re-create this session via the Create Session wizard.'
    );
    e.statusCode = 400;
    throw e;
  }
  try {
    const client = await igClient.getClient(row);
    const probe = await igClient.ping(client);
    if (!probe.ok) {
      await pool.query(
        `UPDATE sessions SET is_logged_in = FALSE, status = 'expired', updated_at = NOW() WHERE id = $1`,
        [sessionId]
      );
      const e = new Error(
        `Instagram session is no longer valid (${probe.error || 'cookies expired'}) — please re-create.`
      );
      e.statusCode = 410;
      throw e;
    }
    await pool.query(
      `UPDATE sessions
          SET is_logged_in = TRUE,
              status = 'active',
              last_login = NOW(),
              last_used = NOW(),
              updated_at = NOW()
        WHERE id = $1`,
      [sessionId]
    );
    logger.info(`IG.login session=${sessionId} user=${userId} ok`);
    return {
      sessionId,
      status: 'active',
      accountInfo: {
        username: row.username,
        platform: 'instagram',
      },
    };
  } catch (err) {
    if (err.statusCode) throw err;
    const e = new Error(`IG re-attach failed: ${err.message}`);
    e.statusCode = 500;
    throw e;
  }
}

async function logoutSession(sessionId, userId) {
  const session = await get(sessionId, userId);
  if (!session) {
    const e = new Error('Session not found');
    e.statusCode = 404;
    throw e;
  }
  // Best-effort: tell IG to revoke the session, then clear local state.
  try {
    const sessionWithBlob = await pool.query(
      `SELECT id, user_id, platform, username, proxy_url, session_data
         FROM sessions WHERE id = $1`,
      [sessionId]
    );
    const client = await igClient.getClient(sessionWithBlob.rows[0]);
    await client.account.logout();
  } catch (err) {
    logger.warn(`IG.logout: remote logout failed (non-fatal): ${err.message}`);
  }

  igClient.releaseClient(sessionId);
  await pool.query(
    `UPDATE sessions
        SET is_logged_in = FALSE,
            status = 'inactive',
            updated_at = NOW()
      WHERE id = $1`,
    [sessionId]
  );
  return { id: sessionId, status: 'inactive', is_logged_in: false };
}

/**
 * Health check — pings i.instagram.com using the stored cookies.
 * Returns the same shape the TG version of this returns (ok / error / user).
 */
async function status(sessionId, userId) {
  const session = await get(sessionId, userId);
  if (!session) return { ok: false, error: 'Session not found' };
  try {
    const fullRow = await pool.query(
      `SELECT id, user_id, platform, username, proxy_url, session_data
         FROM sessions WHERE id = $1`,
      [sessionId]
    );
    const client = await igClient.getClient(fullRow.rows[0]);
    return await igClient.ping(client);
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Re-export the persisted session JSON so the user can move their account
 * between devices.
 */
async function download(sessionId, userId) {
  const result = await pool.query(
    `SELECT id, username, session_data
       FROM sessions
      WHERE id = $1 AND user_id = $2 AND platform = 'instagram'`,
    [sessionId, userId]
  );
  if (result.rows.length === 0) {
    const e = new Error('Session not found');
    e.statusCode = 404;
    throw e;
  }
  const row = result.rows[0];
  if (!row.session_data) {
    const e = new Error('Session has no exported state yet (login first)');
    e.statusCode = 400;
    throw e;
  }
  const decrypted = decrypt(row.session_data);
  return {
    id: row.id,
    username: row.username,
    blob: JSON.parse(decrypted),
  };
}

async function getSessionStats(userId) {
  const result = await pool.query(
    `SELECT
        COUNT(*)::int AS total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END)::int AS active,
        SUM(CASE WHEN is_logged_in THEN 1 ELSE 0 END)::int AS logged_in,
        SUM(CASE WHEN status = 'banned' THEN 1 ELSE 0 END)::int AS banned
       FROM sessions
      WHERE user_id = $1 AND platform = 'instagram'`,
    [userId]
  );
  return result.rows[0];
}

/**
 * Periodic sweep — confirm that each logged-in IG session is still valid.
 * Marks expired ones with status='expired'/is_logged_in=false.
 */
async function heartbeat() {
  const startTime = Date.now();
  const result = await pool.query(
    `SELECT id, user_id, username, proxy_url, session_data, platform_state
       FROM sessions
      WHERE platform = 'instagram'
        AND is_logged_in = TRUE
      ORDER BY COALESCE(last_used, created_at) ASC
      LIMIT 200`
  );
  let healthy = 0;
  let expired = 0;
  for (const row of result.rows) {
    try {
      const client = await igClient.getClient(row);
      const r = await igClient.ping(client);
      if (r.ok) {
        healthy += 1;
        await pool.query(
          `UPDATE sessions SET last_used = NOW(), updated_at = NOW() WHERE id = $1`,
          [row.id]
        );
      } else {
        expired += 1;
        await pool.query(
          `UPDATE sessions
              SET is_logged_in = FALSE,
                  status = 'expired',
                  updated_at = NOW()
            WHERE id = $1`,
          [row.id]
        );
        igClient.releaseClient(row.id);
      }
    } catch (err) {
      logger.warn(`IG.heartbeat session=${row.id}: ${err.message}`);
    }
  }
  logger.info(`IG.heartbeat scanned=${result.rows.length} healthy=${healthy} expired=${expired} ms=${Date.now() - startTime}`);
  return { scanned: result.rows.length, healthy, expired };
}

/**
 * On boot, re-attach in-memory clients for the IG sessions that were
 * logged-in at the previous shutdown. The TG service does the same thing.
 */
async function restoreAll() {
  const result = await pool.query(
    `SELECT id, user_id, username, proxy_url, session_data, platform_state
       FROM sessions
      WHERE platform = 'instagram'
        AND is_logged_in = TRUE
      ORDER BY id`
  );
  let restored = 0;
  for (const row of result.rows) {
    try {
      await igClient.getClient(row);
      restored += 1;
    } catch (err) {
      logger.warn(`IG.restoreAll session=${row.id}: ${err.message}`);
    }
  }
  logger.info(`IG.restoreAll restored=${restored} of ${result.rows.length}`);
  return { restored, total: result.rows.length };
}

module.exports = {
  PLATFORM,
  registerSession,
  upload,
  listSessions,
  list: listSessions,    // alias matching telegram facade
  get,
  getById: get,          // alias for the controller's getSessionById call shape
  delete: deleteSession,
  deleteSession,
  bulkDelete,
  bulkDeleteSessions: bulkDelete,
  login,
  loginSession: login,
  logoutSession,
  logout: logoutSession,
  status,
  getSessionStatus: status,
  checkSessionStatus: status,
  download,
  stats: getSessionStats,
  getSessionStats,
  heartbeat,
  heartbeatLoggedInSessions: heartbeat,
  restoreAll,
  restoreAllLoggedInSessions: restoreAll,
};
