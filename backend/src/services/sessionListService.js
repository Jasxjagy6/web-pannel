/**
 * SessionListService — operator-managed named groups of sessions.
 *
 * The Lists page already manages "user lists" (CSV/JSON imports of
 * Telegram/Instagram users). This is the parallel concept on the
 * other side of the panel: a way to pre-group SESSIONS so flows that
 * today take a session_ids array (messaging, scrape, privacy, groups,
 * change-2FA, get-OTP, OTP relay, anti-detect, account-settings) can
 * also accept a sessionListId and resolve it to that list's members.
 *
 * Per-user, per-platform. Names are case-insensitive unique within a
 * (user, platform) tuple — enforced by a unique index in the v20
 * migration.
 */

const { pool } = require('../config/database');
const { AppError } = require('../utils/errorHandler');
const logger = require('../utils/logger');

const VALID_PLATFORMS = new Set(['telegram', 'instagram']);
const MAX_LIST_NAME_LENGTH = 255;
const MAX_LIST_DESCRIPTION_LENGTH = 1000;
const MAX_SESSIONS_PER_LIST = 500;

function _normPlatform(platform) {
  const p = String(platform || 'telegram').toLowerCase();
  if (!VALID_PLATFORMS.has(p)) {
    throw new AppError(`Invalid platform: ${platform}`, 400, 'INVALID_PLATFORM');
  }
  return p;
}

function _validateName(name) {
  if (!name || typeof name !== 'string') {
    throw new AppError('Session list name is required', 400, 'MISSING_LIST_NAME');
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new AppError('Session list name is required', 400, 'MISSING_LIST_NAME');
  }
  if (trimmed.length > MAX_LIST_NAME_LENGTH) {
    throw new AppError(
      `Session list name must be at most ${MAX_LIST_NAME_LENGTH} chars`,
      400,
      'LIST_NAME_TOO_LONG'
    );
  }
  return trimmed;
}

function _validateDescription(description) {
  if (description == null) return null;
  if (typeof description !== 'string') {
    throw new AppError('Description must be a string', 400, 'BAD_DESCRIPTION');
  }
  if (description.length > MAX_LIST_DESCRIPTION_LENGTH) {
    throw new AppError(
      `Description must be at most ${MAX_LIST_DESCRIPTION_LENGTH} chars`,
      400,
      'DESCRIPTION_TOO_LONG'
    );
  }
  return description;
}

async function _verifySessionsBelongToUser(client, userId, platform, sessionIds) {
  if (!sessionIds || sessionIds.length === 0) return [];
  const r = await client.query(
    `SELECT id FROM sessions
       WHERE id = ANY($1::int[])
         AND user_id = $2
         AND platform = $3`,
    [sessionIds, userId, platform]
  );
  const ownedIds = new Set(r.rows.map((row) => Number(row.id)));
  const missing = sessionIds.filter((id) => !ownedIds.has(Number(id)));
  if (missing.length) {
    throw new AppError(
      `Sessions not found or not owned by this user / platform: ${missing.join(', ')}`,
      400,
      'INVALID_SESSION_IDS'
    );
  }
  return Array.from(ownedIds);
}

/**
 * Create a new session list. Optionally seed with `sessionIds`.
 *
 * @returns {Promise<object>} The created list row, with `session_count`.
 */
async function createList({ userId, platform, name, description, sessionIds = [] }) {
  const plat = _normPlatform(platform);
  const trimmedName = _validateName(name);
  const desc = _validateDescription(description);

  const ids = Array.isArray(sessionIds)
    ? Array.from(new Set(sessionIds.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)))
    : [];
  if (ids.length > MAX_SESSIONS_PER_LIST) {
    throw new AppError(
      `Cannot exceed ${MAX_SESSIONS_PER_LIST} sessions per list`,
      400,
      'TOO_MANY_SESSIONS'
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (ids.length) {
      await _verifySessionsBelongToUser(client, userId, plat, ids);
    }

    const insertList = await client.query(
      `INSERT INTO session_lists (user_id, platform, name, description, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       RETURNING id, user_id, platform, name, description, created_at, updated_at`,
      [userId, plat, trimmedName, desc]
    );
    const list = insertList.rows[0];

    if (ids.length) {
      const values = ids.map((_, i) => `($1, $${i + 2})`).join(', ');
      await client.query(
        `INSERT INTO session_list_members (list_id, session_id)
         VALUES ${values}
         ON CONFLICT DO NOTHING`,
        [list.id, ...ids]
      );
    }

    await client.query('COMMIT');
    logger.info(
      `SessionList created id=${list.id} user=${userId} platform=${plat} name="${trimmedName}" sessions=${ids.length}`
    );
    return { ...list, session_count: ids.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err && err.code === '23505') {
      throw new AppError(
        `A session list named "${trimmedName}" already exists for this platform`,
        409,
        'DUPLICATE_LIST_NAME'
      );
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * List the caller's session lists (optionally filtered to a single platform).
 */
async function listLists({ userId, platform = null, search = null }) {
  const params = [userId];
  let where = 'WHERE sl.user_id = $1';
  if (platform) {
    params.push(_normPlatform(platform));
    where += ` AND sl.platform = $${params.length}`;
  }
  if (search && typeof search === 'string' && search.trim().length) {
    params.push(`%${search.trim().toLowerCase()}%`);
    where += ` AND lower(sl.name) LIKE $${params.length}`;
  }
  const r = await pool.query(
    `SELECT sl.id, sl.user_id, sl.platform, sl.name, sl.description,
            sl.created_at, sl.updated_at,
            COALESCE(m.cnt, 0)::int AS session_count
       FROM session_lists sl
       LEFT JOIN (
         SELECT list_id, COUNT(*)::int AS cnt
           FROM session_list_members
           GROUP BY list_id
       ) m ON m.list_id = sl.id
       ${where}
       ORDER BY sl.created_at DESC, sl.id DESC`,
    params
  );
  return r.rows;
}

async function getList({ userId, listId }) {
  const r = await pool.query(
    `SELECT sl.id, sl.user_id, sl.platform, sl.name, sl.description,
            sl.created_at, sl.updated_at,
            COALESCE(m.cnt, 0)::int AS session_count
       FROM session_lists sl
       LEFT JOIN (
         SELECT list_id, COUNT(*)::int AS cnt
           FROM session_list_members
           GROUP BY list_id
       ) m ON m.list_id = sl.id
       WHERE sl.id = $1 AND sl.user_id = $2`,
    [listId, userId]
  );
  if (r.rows.length === 0) {
    throw new AppError('Session list not found', 404, 'LIST_NOT_FOUND');
  }
  return r.rows[0];
}

/**
 * Return all session rows that belong to the list (joined onto sessions).
 */
async function getListSessions({ userId, listId, includeAll = false }) {
  await getList({ userId, listId }); // owner check
  // includeAll=false (default) hides logged-out / dead sessions so the
  // resolver returns a clean list to the bulk-action controllers.
  const params = [listId];
  let extra = '';
  if (!includeAll) {
    extra = `
      AND s.is_logged_in = TRUE
      AND COALESCE(s.warmup_state->>'state', 'active') NOT IN ('dead')
    `;
  }
  const r = await pool.query(
    `SELECT s.id, s.user_id, s.platform, s.username, s.phone,
            s.status, s.is_logged_in, s.is_2fa_enabled,
            s.account_info, s.warmup_state, m.added_at
       FROM session_list_members m
       JOIN sessions s ON s.id = m.session_id
       WHERE m.list_id = $1
       ${extra}
       ORDER BY m.added_at ASC, s.id ASC`,
    params
  );
  return r.rows;
}

async function updateList({ userId, listId, name, description }) {
  const sets = [];
  const params = [];
  if (name !== undefined) {
    const trimmed = _validateName(name);
    params.push(trimmed);
    sets.push(`name = $${params.length}`);
  }
  if (description !== undefined) {
    const desc = _validateDescription(description);
    params.push(desc);
    sets.push(`description = $${params.length}`);
  }
  if (sets.length === 0) {
    return getList({ userId, listId });
  }
  sets.push('updated_at = NOW()');
  params.push(listId, userId);
  try {
    const r = await pool.query(
      `UPDATE session_lists SET ${sets.join(', ')}
         WHERE id = $${params.length - 1} AND user_id = $${params.length}
         RETURNING id`,
      params
    );
    if (r.rowCount === 0) {
      throw new AppError('Session list not found', 404, 'LIST_NOT_FOUND');
    }
    return getList({ userId, listId });
  } catch (err) {
    if (err && err.code === '23505') {
      throw new AppError(
        'A session list with this name already exists for this platform',
        409,
        'DUPLICATE_LIST_NAME'
      );
    }
    throw err;
  }
}

async function deleteList({ userId, listId }) {
  const r = await pool.query(
    `DELETE FROM session_lists WHERE id = $1 AND user_id = $2 RETURNING id`,
    [listId, userId]
  );
  if (r.rowCount === 0) {
    throw new AppError('Session list not found', 404, 'LIST_NOT_FOUND');
  }
  logger.info(`SessionList deleted id=${listId} user=${userId}`);
  return { id: listId };
}

async function addSessions({ userId, listId, sessionIds }) {
  const list = await getList({ userId, listId });
  const ids = Array.from(
    new Set((sessionIds || []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0))
  );
  if (ids.length === 0) {
    throw new AppError('At least one sessionId is required', 400, 'MISSING_SESSION_IDS');
  }
  // capacity check
  const capCheck = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM session_list_members WHERE list_id = $1`,
    [listId]
  );
  const current = capCheck.rows[0].cnt || 0;
  if (current + ids.length > MAX_SESSIONS_PER_LIST) {
    throw new AppError(
      `Cannot exceed ${MAX_SESSIONS_PER_LIST} sessions per list (currently ${current})`,
      400,
      'TOO_MANY_SESSIONS'
    );
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await _verifySessionsBelongToUser(client, userId, list.platform, ids);
    const values = ids.map((_, i) => `($1, $${i + 2})`).join(', ');
    await client.query(
      `INSERT INTO session_list_members (list_id, session_id)
       VALUES ${values}
       ON CONFLICT DO NOTHING`,
      [listId, ...ids]
    );
    await client.query(
      `UPDATE session_lists SET updated_at = NOW() WHERE id = $1`,
      [listId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return getList({ userId, listId });
}

async function removeSessions({ userId, listId, sessionIds }) {
  await getList({ userId, listId });
  const ids = Array.from(
    new Set((sessionIds || []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0))
  );
  if (ids.length === 0) {
    throw new AppError('At least one sessionId is required', 400, 'MISSING_SESSION_IDS');
  }
  await pool.query(
    `DELETE FROM session_list_members WHERE list_id = $1 AND session_id = ANY($2::int[])`,
    [listId, ids]
  );
  await pool.query(
    `UPDATE session_lists SET updated_at = NOW() WHERE id = $1`,
    [listId]
  );
  return getList({ userId, listId });
}

/**
 * Replace the membership of a list with a new set (idempotent).
 */
async function setSessions({ userId, listId, sessionIds }) {
  const list = await getList({ userId, listId });
  const ids = Array.from(
    new Set((sessionIds || []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0))
  );
  if (ids.length > MAX_SESSIONS_PER_LIST) {
    throw new AppError(
      `Cannot exceed ${MAX_SESSIONS_PER_LIST} sessions per list`,
      400,
      'TOO_MANY_SESSIONS'
    );
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (ids.length) {
      await _verifySessionsBelongToUser(client, userId, list.platform, ids);
    }
    await client.query(
      `DELETE FROM session_list_members WHERE list_id = $1`,
      [listId]
    );
    if (ids.length) {
      const values = ids.map((_, i) => `($1, $${i + 2})`).join(', ');
      await client.query(
        `INSERT INTO session_list_members (list_id, session_id)
         VALUES ${values}
         ON CONFLICT DO NOTHING`,
        [listId, ...ids]
      );
    }
    await client.query(
      `UPDATE session_lists SET updated_at = NOW() WHERE id = $1`,
      [listId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return getList({ userId, listId });
}

/**
 * Resolve `{ sessionIds, sessionListId }` to a concrete array of
 * session ids, owned by the caller and on the given platform.
 *
 * - If `sessionListId` is provided, expand to that list's members
 *   (filtered to active, logged-in sessions when `includeAll` is false).
 * - Otherwise return `sessionIds` unchanged after a quick ownership check.
 *
 * @returns {Promise<number[]>}
 */
async function resolveSessionIds({
  userId,
  platform,
  sessionIds,
  sessionListId,
  includeAll = false,
}) {
  if (sessionListId != null && sessionListId !== '') {
    const id = Number(sessionListId);
    if (!Number.isFinite(id) || id <= 0) {
      throw new AppError('Invalid sessionListId', 400, 'INVALID_LIST_ID');
    }
    const list = await getList({ userId, listId: id });
    if (platform && list.platform !== _normPlatform(platform)) {
      throw new AppError(
        `Session list ${id} belongs to platform '${list.platform}', not '${platform}'`,
        400,
        'PLATFORM_MISMATCH'
      );
    }
    const rows = await getListSessions({ userId, listId: id, includeAll });
    const ids = rows.map((r) => Number(r.id));
    if (ids.length === 0) {
      throw new AppError(
        `Session list "${list.name}" has no active sessions`,
        400,
        'EMPTY_SESSION_LIST'
      );
    }
    return ids;
  }
  // No list → trust caller's sessionIds. (Ownership is enforced by the
  // downstream service when it loads the rows.)
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) return [];
  return sessionIds.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
}

module.exports = {
  createList,
  listLists,
  getList,
  getListSessions,
  updateList,
  deleteList,
  addSessions,
  removeSessions,
  setSessions,
  resolveSessionIds,
  MAX_SESSIONS_PER_LIST,
};
