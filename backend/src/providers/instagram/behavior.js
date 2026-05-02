/**
 * Instagram behavior simulation (provider.behavior.*).
 *
 * Mirrors the TG behavior service: kicks off a long-running pretender
 * loop that scrolls the inbox, opens stories at random, etc., to make a
 * fresh account look human.
 *
 * Implementation here is a lightweight scheduler — a single in-memory map
 * keyed by sessionId tracks which sessions are "running" simulation, and
 * an interval runs `client.simulate.preLoginFlow()` / `postLoginFlow()`
 * style sequences periodically. Heavy lift can be migrated to BullMQ later.
 */

const { pool } = require('../../config/database');
const igClient = require('./client');
const logger = require('../../utils/logger');

const _running = new Map(); // sessionId → interval handle

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

async function _tick(session) {
  try {
    const client = await igClient.getClient(session);
    // Browse a few feeds — non-mutating, harmless.
    await client.feed.timeline().items();
    await client.feed.directInbox().items();
    await client.feed.news().items();
  } catch (err) {
    logger.warn(`IG.behavior tick session=${session.id} failed: ${err.message}`);
  }
}

async function start({ userId, sessionId, intervalMs = 5 * 60 * 1000 }) {
  if (_running.has(sessionId)) {
    return { sessionId, started: false, reason: 'already_running' };
  }
  const session = await _session({ userId, sessionId });
  const handle = setInterval(() => _tick(session), intervalMs);
  handle.unref?.();
  _running.set(sessionId, handle);
  logger.info(`IG.behavior.start session=${sessionId} intervalMs=${intervalMs}`);
  return { sessionId, started: true, intervalMs };
}

async function stop({ sessionId }) {
  const handle = _running.get(sessionId);
  if (handle) {
    clearInterval(handle);
    _running.delete(sessionId);
  }
  return { sessionId, stopped: !!handle };
}

async function getStatus({ sessionId }) {
  return { sessionId, running: _running.has(sessionId) };
}

module.exports = {
  start,
  stop,
  getStatus,
};
