'use strict';

const { pool } = require('../config/database');

const VALID_SPAM_STATUSES = new Set(['unknown', 'clean', 'limited', 'frozen']);
const CACHE_TTL_MS = 5000;
const statusCache = new Map();

function normalizeStatus(status) {
  const value = String(status || 'unknown').toLowerCase();
  return VALID_SPAM_STATUSES.has(value) ? value : 'unknown';
}

function setCached(sessionId, status) {
  statusCache.set(String(sessionId), {
    status: normalizeStatus(status),
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

async function getStatus(sessionId) {
  const key = String(sessionId);
  const cached = statusCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.status;

  const { rows } = await pool.query(
    `SELECT COALESCE(spam_status, 'unknown') AS spam_status
       FROM sessions
      WHERE id = $1 AND platform = 'telegram'`,
    [sessionId]
  );
  const status = rows.length ? normalizeStatus(rows[0].spam_status) : 'unknown';
  setCached(key, status);
  return status;
}

async function assertUsable(sessionId, { allowFrozen = false } = {}) {
  if (allowFrozen || await getStatus(sessionId) !== 'frozen') return;

  const err = new Error(
    `Session ${sessionId} is frozen by Telegram and is excluded until its @SpamBot status is rechecked as clean.`
  );
  err.code = 'SESSION_FROZEN';
  err.errorCode = 'SESSION_FROZEN';
  err.statusCode = 423;
  throw err;
}

async function filterUsableSessionIds(sessionIds, {
  userId,
  platform = 'telegram',
  includeFrozen = false,
} = {}) {
  const ids = Array.from(new Set(
    (Array.isArray(sessionIds) ? sessionIds : [])
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0)
  ));
  if (ids.length === 0 || platform !== 'telegram' || includeFrozen) return ids;

  const params = [ids];
  let ownerClause = '';
  if (userId != null) {
    params.push(Number(userId));
    ownerClause = ` AND user_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT id
       FROM sessions
      WHERE id = ANY($1::int[])
        AND platform = 'telegram'
        AND COALESCE(spam_status, 'unknown') <> 'frozen'
        ${ownerClause}`,
    params
  );
  const usable = new Set(rows.map((row) => Number(row.id)));
  return ids.filter((id) => usable.has(id));
}

async function recordStatus(sessionId, status, message = null, { limitUntil = null } = {}) {
  const normalized = normalizeStatus(status);
  const parsedLimitUntil = limitUntil instanceof Date && !Number.isNaN(limitUntil.getTime())
    ? limitUntil
    : null;

  await pool.query(
    `UPDATE sessions
        SET spam_status = $2,
            spam_checked_at = NOW(),
            spam_status_message = $3,
            spam_limit_until = $4,
            updated_at = NOW()
      WHERE id = $1 AND platform = 'telegram'`,
    [
      sessionId,
      normalized,
      message ? String(message).slice(0, 4000) : null,
      normalized === 'limited' ? parsedLimitUntil : null,
    ]
  );
  setCached(sessionId, normalized);
  if (normalized === 'frozen') {
    await require('./aiChatService')._forceFrozenOff(sessionId).catch(() => {});
  }
}

module.exports = {
  assertUsable,
  filterUsableSessionIds,
  getStatus,
  recordStatus,
  VALID_SPAM_STATUSES,
};
