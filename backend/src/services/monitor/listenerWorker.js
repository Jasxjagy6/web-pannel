/**
 * listenerWorker — per-shift NewMessage + Raw listener for monitor V2.
 *
 * Lifecycle
 * ---------
 *   start(shift) — acquire session lock, resolve entity, attach
 *                  NewMessage + Raw handlers, mark shift 'active'.
 *   stop(shift)  — detach handlers, release lock, mark shift 'ended'.
 *
 * One shift = one (chat, session, time-window). When a session goes on
 * multiple chats simultaneously, each chat gets its own listenerWorker
 * instance — they share session-level lock acquisition via
 * sessionOwnershipLock (the underlying GramJS client is reused).
 *
 * All observations flow into the shared `observationFunnel` so dedup,
 * enrichment, and fatigue accounting are unified across concurrent
 * listeners on the same chat.
 */

'use strict';

const { pool } = require('../../config/database');
const logger = require('../../utils/logger');
const telegramService = require('../telegramService');
const sessionOwnershipLock = require('../sessionOwnershipLock');
const os = require('os');
const funnel = require('./observationFunnel');

const WORKER_ID = `${os.hostname()}#${process.pid}`;

// Reuse the helpers from the v1 monitor.  They are stable and we don't
// want to duplicate or fork their behaviour.
const v1 = require('../scrapeMonitorService');
// Cross-import surface: we need the raw-update classnames + extractors
// only.  scrapeMonitorService re-exports them on `__internals` to keep
// this coupling explicit (added below in the legacy module).
const {
  RAW_UPDATE_CLASSNAMES,
  extractSenderProfile,
  extractSenderFromRawUpdate,
  harvestPiggybackedUsers,
  eventChatCandidates,
  eventMatchesTarget,
} = v1.__internals || {};

const HANDOFF_LEAD_SEC = 2;   // mark 'handoff' this many seconds before planned_end

if (!RAW_UPDATE_CLASSNAMES) {
  // Defensive: the v1 module must export __internals or this whole
  // pipeline silently produces nothing.  Loud crash is better than
  // silent broken.
  throw new Error(
    'listenerWorker: scrapeMonitorService.__internals not found. ' +
    'Update scrapeMonitorService to export RAW_UPDATE_CLASSNAMES and helpers.'
  );
}

class ListenerWorker {
  constructor() {
    /** shiftId → context */
    this._active = new Map();
  }

  /**
   * Bring a shift online.  Returns true on success, false on a
   * non-fatal failure (orchestrator will reschedule).
   */
  async start(shift) {
    if (!shift || !shift.id) return false;
    if (this._active.has(shift.id)) return true;

    const ctx = {
      shiftId: shift.id,
      monitorChatId: shift.monitorChatId,
      monitorJobId: shift.monitorJobId,
      userId: shift.userId,
      sessionId: String(shift.sessionId),
      targetId: shift.targetId,
      plannedEnd: new Date(shift.plannedEnd),
      lockToken: null,
      unsubNewMessage: null,
      unsubRaw: null,
      allowedChatIds: null,
      stopped: false,
      endTimer: null,
      handoffTimer: null,
    };

    // Mark warming so the orchestrator sees this shift as "in progress
    // of starting" rather than "pending".
    await this._setShiftState(shift.id, 'warming');

    // Acquire the auth_key lock.  Fail-fast on already-held; the
    // orchestrator picks a different session next tick.
    try {
      ctx.lockToken = await sessionOwnershipLock.acquire(
        ctx.sessionId,
        `monitor:shift:${shift.id}`
      );
    } catch (err) {
      logger.warn(`listenerWorker.acquire(${ctx.sessionId}) failed: ${err.message}`);
      await this._setShiftState(shift.id, 'failed', err.message);
      return false;
    }
    if (!ctx.lockToken) {
      await this._setShiftState(shift.id, 'failed', 'lock_held_elsewhere');
      return false;
    }

    // Build the allowed-chat-ids set used by the defense-in-depth
    // filter.  We pass it as a Set so the helper can self-warm.
    ctx.allowedChatIds = new Set();
    ctx.allowedChatIds.add(String(ctx.targetId));
    if (/^-?\d+$/.test(String(ctx.targetId))) {
      ctx.allowedChatIds.add(String(ctx.targetId).replace(/^-100/, ''));
      ctx.allowedChatIds.add(String(ctx.targetId).replace(/^-/, ''));
    }

    // Warm peer cache on this session.  Failures are logged but not
    // fatal — the filter's self-warming logic handles late resolution.
    try {
      await telegramService._resolveEntity(ctx.sessionId, ctx.targetId);
    } catch (err) {
      logger.debug(
        `listenerWorker resolve(${ctx.sessionId}, ${ctx.targetId}): ${err.message}`
      );
    }

    funnel.registerSession(ctx.monitorChatId, ctx.sessionId);
    // Best-effort participant prime — many admin-only groups still
    // allow getParticipants under specific admin rights; if so, this
    // gives us a free 5k-user enrichment cache before any event arrives.
    // We don't await; it can run alongside listening.
    funnel.primeParticipantCache(
      ctx.monitorChatId, [ctx.sessionId], ctx.targetId
    ).catch(() => {});

    // ---- NewMessage handler ----------------------------------------
    try {
      const unsub = await telegramService.addNewMessageHandler(
        ctx.sessionId,
        (event) => this._onNewMessage(ctx, event)
      );
      ctx.unsubNewMessage = unsub;
    } catch (err) {
      logger.warn(
        `listenerWorker addNewMessageHandler(${ctx.sessionId}): ${err.message}`
      );
      await this._cleanupAfterFailure(ctx, err.message);
      return false;
    }

    // ---- Raw handler -----------------------------------------------
    try {
      const unsub = await telegramService.addRawUpdateHandler(
        ctx.sessionId,
        (update) => this._onRawUpdate(ctx, update)
      );
      ctx.unsubRaw = unsub;
    } catch (err) {
      logger.warn(
        `listenerWorker addRawUpdateHandler(${ctx.sessionId}): ${err.message}`
      );
      try { ctx.unsubNewMessage?.(); } catch {}
      await this._cleanupAfterFailure(ctx, err.message);
      return false;
    }

    // Mark active in DB.
    await pool.query(
      `UPDATE scrape_monitor_shifts
          SET state = 'active', actual_start = NOW(), updated_at = NOW(),
              worker_id = $2, fencing_token = $3
        WHERE id = $1`,
      [shift.id, WORKER_ID, String(ctx.lockToken)]
    );

    this._active.set(shift.id, ctx);

    // Auto-stop timer at planned_end.  We arm it in absolute terms so
    // process drift doesn't matter much.
    const msToEnd = ctx.plannedEnd.getTime() - Date.now();
    if (msToEnd > 1000) {
      // Mark 'handoff' shortly before the end so the orchestrator
      // knows the successor's overlap should already be live.
      const msToHandoff = Math.max(
        100, msToEnd - HANDOFF_LEAD_SEC * 1000
      );
      ctx.handoffTimer = setTimeout(() => {
        this._setShiftState(ctx.shiftId, 'handoff').catch(() => {});
      }, msToHandoff);
      ctx.handoffTimer.unref?.();

      ctx.endTimer = setTimeout(() => {
        this.stop(ctx.shiftId, 'planned_end').catch((e) =>
          logger.warn(`auto-stop shift ${ctx.shiftId}: ${e.message}`)
        );
      }, msToEnd);
      ctx.endTimer.unref?.();
    } else {
      // Planned_end already passed — stop immediately.  This is a
      // degenerate case but better-safe-than-leak.
      this.stop(ctx.shiftId, 'planned_end_in_past').catch(() => {});
    }

    return true;
  }

  /**
   * Tear a shift down.
   */
  async stop(shiftId, reason = 'planned_end') {
    const ctx = this._active.get(shiftId);
    if (!ctx) return false;
    if (ctx.stopped) return true;
    ctx.stopped = true;
    this._active.delete(shiftId);

    if (ctx.endTimer) { clearTimeout(ctx.endTimer); ctx.endTimer = null; }
    if (ctx.handoffTimer) { clearTimeout(ctx.handoffTimer); ctx.handoffTimer = null; }

    try { ctx.unsubNewMessage?.(); } catch (err) {
      logger.debug(`unsub NewMessage shift ${shiftId}: ${err.message}`);
    }
    try { ctx.unsubRaw?.(); } catch (err) {
      logger.debug(`unsub Raw shift ${shiftId}: ${err.message}`);
    }

    funnel.unregisterSession(ctx.monitorChatId, ctx.sessionId);

    if (ctx.lockToken) {
      try {
        await sessionOwnershipLock.release(ctx.sessionId, ctx.lockToken);
      } catch (err) {
        logger.debug(`release lock shift ${shiftId}: ${err.message}`);
      }
    }

    // Persist final shift outcome.
    const finalState = reason === 'failed' ? 'failed' : 'ended';
    try {
      await pool.query(
        `UPDATE scrape_monitor_shifts
            SET state = $2, actual_end = NOW(), updated_at = NOW(),
                fail_reason = COALESCE(fail_reason, $3)
          WHERE id = $1`,
        [shiftId, finalState, finalState === 'failed' ? reason : null]
      );
    } catch (err) {
      logger.debug(`set ended state shift ${shiftId}: ${err.message}`);
    }

    return true;
  }

  /**
   * Cancel ALL shifts for a chat (used when the operator stops a chat).
   */
  async stopChat(monitorChatId, reason = 'cancelled') {
    const toStop = [];
    for (const [, ctx] of this._active) {
      if (ctx.monitorChatId === monitorChatId) toStop.push(ctx.shiftId);
    }
    for (const sid of toStop) await this.stop(sid, reason);
    return toStop.length;
  }

  /**
   * Cancel ALL shifts for a job (used when the operator stops a job).
   */
  async stopJob(monitorJobId, reason = 'cancelled') {
    const toStop = [];
    for (const [, ctx] of this._active) {
      if (ctx.monitorJobId === monitorJobId) toStop.push(ctx.shiftId);
    }
    for (const sid of toStop) await this.stop(sid, reason);
    return toStop.length;
  }

  /**
   * Shift IDs currently held by this worker (for orchestrator
   * book-keeping / health checks).
   */
  activeShifts() {
    return Array.from(this._active.values()).map((c) => ({
      shiftId: c.shiftId,
      monitorChatId: c.monitorChatId,
      monitorJobId: c.monitorJobId,
      sessionId: c.sessionId,
      plannedEnd: c.plannedEnd,
    }));
  }

  // -------------------------------------------------------------------
  // INTERNAL
  // -------------------------------------------------------------------

  async _onNewMessage(ctx, event) {
    if (ctx.stopped) return;
    try {
      if (!eventMatchesTarget(event, ctx.allowedChatIds)) return;
      const piggybacked = harvestPiggybackedUsers(event);
      const profile = await extractSenderProfile(event);
      if (!profile) return;
      await funnel.observe({
        monitorChatId: ctx.monitorChatId,
        monitorJobId: ctx.monitorJobId,
        userId: ctx.userId,
        sessionId: ctx.sessionId,
        targetId: ctx.targetId,
        profile,
        kind: 'message',
        piggybackUsers: piggybacked,
      });
    } catch (err) {
      logger.debug(`_onNewMessage shift ${ctx.shiftId}: ${err.message}`);
    }
  }

  async _onRawUpdate(ctx, update) {
    if (ctx.stopped) return;
    try {
      if (!update || !update.className) return;
      // Fast reject for irrelevant update classes; cheap to skip.
      if (!RAW_UPDATE_CLASSNAMES.has(update.className)) return;
      if (!eventMatchesTarget(update, ctx.allowedChatIds)) return;
      const piggybacked = harvestPiggybackedUsers(update);
      const profile = extractSenderFromRawUpdate(update);
      if (!profile) return;
      await funnel.observe({
        monitorChatId: ctx.monitorChatId,
        monitorJobId: ctx.monitorJobId,
        userId: ctx.userId,
        sessionId: ctx.sessionId,
        targetId: ctx.targetId,
        profile,
        kind: 'raw',
        piggybackUsers: piggybacked,
      });
    } catch (err) {
      logger.debug(`_onRawUpdate shift ${ctx.shiftId}: ${err.message}`);
    }
  }

  async _setShiftState(shiftId, state, failReason = null) {
    try {
      const params = [shiftId, state];
      let sql = `UPDATE scrape_monitor_shifts
                    SET state = $2, updated_at = NOW()`;
      if (failReason) {
        sql += `, fail_reason = $3`;
        params.push(failReason);
      }
      sql += ` WHERE id = $1`;
      await pool.query(sql, params);
    } catch (err) {
      logger.debug(`_setShiftState(${shiftId}, ${state}): ${err.message}`);
    }
  }

  async _cleanupAfterFailure(ctx, reason) {
    if (ctx.lockToken) {
      try {
        await sessionOwnershipLock.release(ctx.sessionId, ctx.lockToken);
      } catch {}
      ctx.lockToken = null;
    }
    funnel.unregisterSession(ctx.monitorChatId, ctx.sessionId);
    await this._setShiftState(ctx.shiftId, 'failed', reason);
  }
}

module.exports = new ListenerWorker();
