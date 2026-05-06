/**
 * Cold-start simulation (Phase 1, B8).
 *
 * After a process restart, a session that hasn't made any IG request
 * since boot looks suspicious if its very first call is a "real" action
 * (DM send, profile edit, scrape). Real users always check their feed,
 * inbox, and notifications first — that's the natural cadence of
 * opening the app.
 *
 * `runIfCold(session)` is called from any IG egress entry point. If
 * the session's pool entry is not yet `warmed`, it executes a small
 * sequence of innocuous reads (feed → inbox → notifications/badge),
 * each going through `sessionLimiter` so the burst is correctly
 * spaced. Once done, marks the pool entry as warmed.
 *
 * The simulation is per-process (warmed flag lives in the in-memory
 * client pool). A process restart re-arms it.
 *
 * Failure mode: if any warmup call fails with a real IG error
 * (checkpoint, login_required), we let it propagate; the operator
 * needs to see that the session is dead. Network / 5xx errors are
 * swallowed so a transient hiccup doesn't pin a session as warm-failed.
 */

'use strict';

const logger = require('../../utils/logger');
const igClient = require('./client');
const sessionLimiter = require('./sessionLimiter');

const _inFlight = new Map(); // sessionId -> Promise (dedupe concurrent callers)

/**
 * Run a cold-start sequence if this session hasn't been warmed in
 * this process yet. Returns once warmup is complete (success or
 * failure). Concurrent callers get the same in-flight promise.
 */
async function runIfCold(session) {
  if (!session || !session.id) return;
  if (igClient.isWarmed(session.id)) return;

  // Dedupe — two concurrent egress calls for the same session
  // shouldn't trigger two parallel warmups.
  if (_inFlight.has(session.id)) {
    return _inFlight.get(session.id);
  }

  const p = (async () => {
    try {
      await _runSequence(session);
      igClient.markWarmed(session.id);
      logger.info(`IG.coldStart: session=${session.id} warmed`);
    } catch (err) {
      // Hard auth errors are surfaced — the caller likely already
      // catches them. Network errors are logged and swallowed; we'll
      // try again next time.
      const kind = err && err.kind;
      if (kind === 'checkpoint' || kind === 'login_required' || kind === 'action_blocked') {
        logger.warn(`IG.coldStart: session=${session.id} warmup failed (${kind}): ${err.message}`);
        throw err;
      }
      logger.warn(`IG.coldStart: session=${session.id} warmup soft-failed: ${err.message}`);
    } finally {
      _inFlight.delete(session.id);
    }
  })();

  _inFlight.set(session.id, p);
  return p;
}

async function _runSequence(session) {
  const apiMode =
    (session.platform_state && session.platform_state.api_mode) ||
    ((session.platform_state && session.platform_state.source === 'browser_cookies')
      ? 'web' : 'mobile');

  // Browser-cookie sessions arrive already-warm: the cookies were
  // exported from a real, recently-active browser session, so the
  // user has already "opened the app" themselves before we started
  // hitting IG. Re-running the timeline/inbox/news triplet from the
  // panel host (often a data-centre IP) just adds three extra
  // requests that IG can rate-limit BEFORE we even get to the real
  // scrape call. Keeping cold-start mobile-only meaningfully cuts
  // the "first request returns 429" failure mode operators were
  // seeing on web/cookie sessions.
  if (apiMode === 'web') {
    logger.debug(`IG.coldStart: session=${session.id} skipping web warmup (cookies are already-warm)`);
    return;
  }
  await _warmupMobile(session);
}

async function _warmupMobile(session) {
  const client = await igClient.getClient(session);

  // Innocuous reads in a natural-feeling order:
  //   1. timeline feed (open the app)
  //   2. direct inbox (check messages)
  //   3. news feed (notifications)
  // Each consumes a read token so the spread is enforced.
  const steps = [
    async () => {
      await sessionLimiter.acquire(session.id, { class: 'read' });
      const feed = client.feed.timeline();
      await feed.items();
    },
    async () => {
      await sessionLimiter.acquire(session.id, { class: 'read' });
      // direct inbox is a read of the user's own threads
      try {
        await client.feed.directInbox().items();
      } catch (_e) {
        // some accounts have no inbox feed; ignore
      }
    },
    async () => {
      await sessionLimiter.acquire(session.id, { class: 'read' });
      try {
        await client.feed.news().items();
      } catch (_e) { /* ignore */ }
    },
  ];

  for (const step of steps) {
    await step();
  }
}

async function _warmupWeb(session) {
  // For web (cookie-uploaded) sessions we hit the equivalent web
  // endpoints. These are all GETs that a real browser fires when
  // landing on instagram.com after login.
  // eslint-disable-next-line global-require
  const { igFetch, sessionContext } = require('./igFetch');
  const ctx = await sessionContext(session);

  const urls = [
    {
      url: 'https://www.instagram.com/api/v1/feed/timeline/',
      referer: 'https://www.instagram.com/',
    },
    {
      url: 'https://www.instagram.com/api/v1/direct_v2/inbox/?persistentBadging=true&folder=&thread_message_limit=10&limit=20',
      referer: 'https://www.instagram.com/direct/inbox/',
    },
    {
      url: 'https://www.instagram.com/api/v1/news/inbox/',
      referer: 'https://www.instagram.com/',
    },
  ];

  for (const { url, referer } of urls) {
    try {
      // The limiter is applied inside igFetch automatically.
      await igFetch(ctx, url, { referer, logErrors: false });
    } catch (err) {
      // Surface auth errors; soft-fail on network.
      const kind = err && err.kind;
      if (kind === 'checkpoint' || kind === 'login_required' || kind === 'action_blocked') {
        throw err;
      }
      logger.warn(`IG.coldStart.web: soft-fail url=${url}: ${err.message}`);
    }
  }
}

module.exports = {
  runIfCold,
};
