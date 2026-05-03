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
const sessionLimiter = require('./sessionLimiter');
const activeHours = require('./activeHours');
const behaviorPacing = require('./behaviorPacing');
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

/**
 * Phase 2.B11 — execute one realistic action chosen from the
 * weighted action mix. Each kind maps to a single IG read; the
 * sessionLimiter keeps spacing honest, and activeHours keeps the
 * loop quiet outside the session's waking window.
 *
 * Failures are logged-and-swallowed: the warmup loop must NOT throw
 * and break the interval handle.
 */
async function _tick(session) {
  // Respect the active-hours window; outside it, the warmup loop
  // is a no-op so a session in the middle of the night doesn't
  // generate egress.
  if (!activeHours.isWithinActiveHours(session)) return;

  // Respect feedback_required cooldown.
  if (behaviorPacing.isInFeedbackCooldown(session)) return;

  const action = behaviorPacing.pickAction();

  try {
    await sessionLimiter.acquire(session.id, { class: 'read' });
    const client = await igClient.getClient(session);

    switch (action) {
      case 'feed_timeline':
        await client.feed.timeline().items();
        break;
      case 'feed_explore':
        // Explore feed; falls back to timeline if not available on the
        // version of instagram-private-api in use.
        if (client.feed.discover) {
          await client.feed.discover().items();
        } else {
          await client.feed.timeline().items();
        }
        break;
      case 'view_story':
        // Pull the story tray and stop there — opening a story is a
        // separate write-class action we don't want from a passive
        // pretender loop.
        await client.feed.reelsTray().items?.();
        break;
      case 'feed_user_profile':
        // Open the session-owner's own profile (no risk of accidental
        // follow). Real users do this often.
        try {
          await client.account.currentUser();
        } catch (_e) { /* private API may differ; ignore */ }
        break;
      case 'search':
        // Search the session-owner's username — the cheapest
        // search the API has.
        if (session.username) {
          try {
            await client.user.searchExact(session.username);
          } catch (_e) { /* ignore */ }
        }
        break;
      case 'react_post':
        // No-op for now — actually liking a post is a write and we
        // don't want a passive loop touching writes. Burn a read
        // instead so the slot is consumed.
        await client.feed.timeline().items();
        break;
      case 'inbox_check':
        await client.feed.directInbox().items();
        break;
      case 'notifications':
        await client.feed.news().items();
        break;
      default:
        await client.feed.timeline().items();
    }
  } catch (err) {
    logger.warn(`IG.behavior tick session=${session.id} action=${action} failed: ${err.message}`);
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
