/**
 * restoreScheduler — institutional boot-time session reconnect throttler.
 *
 * Anti-revoke Phase 1 (B5):
 *
 * Without throttling, a panel restart with N logged-in sessions
 * reconnects all of them to Telegram from the same VPS IP within <1 s.
 * Telegram's anti-spam pipeline classifies that pattern as a
 * "data-centre sweep" and mass-revokes the affected auth keys. So we
 * stagger restores over RESTORE_WINDOW_MS with a random delay between
 * each, plus a hard cap of RESTORE_PER_IP_PER_MIN (default 4) so two
 * fast restarts can't burst either.
 *
 * The scheduler is dependency-free so unit tests can drive it without
 * setting up Postgres / Redis / GramJS.
 *
 * Usage:
 *   const restoreScheduler = require('../utils/restoreScheduler');
 *   await restoreScheduler.run({
 *     items: [1, 2, 3, ...],
 *     windowMs: 5 * 60 * 1000,
 *     perMinuteCap: 4,
 *     handler: async (id) => { await loadSession(id); },
 *     onProgress: (idx, total, ms) => {...},
 *   });
 */

'use strict';

const logger = require('./logger');

function _sleep(ms) {
  return new Promise((res) => setTimeout(res, Math.max(0, ms)));
}

/**
 * Compute a randomized delay schedule that:
 *   - spreads `count` items uniformly across `windowMs`
 *   - jitters each slot by ±jitterFactor of the slot width
 *   - never exceeds `perMinuteCap` reconnects in any rolling 60 s window
 *
 * Returns an array of cumulative delays in ms (one per item, monotonically
 * non-decreasing).
 */
function buildSchedule(count, windowMs, perMinuteCap, jitterFactor = 0.4) {
  if (count <= 0) return [];
  const slot = count > 0 ? Math.max(0, windowMs) / count : 0;
  const jitter = slot * Math.max(0, Math.min(jitterFactor, 0.9));
  const minGapMs = perMinuteCap > 0 ? Math.ceil(60_000 / perMinuteCap) : 0;
  const out = [];
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const target = (i + 0.5) * slot + (Math.random() * 2 - 1) * jitter;
    cursor = Math.max(cursor, target);
    if (i > 0 && cursor - out[i - 1] < minGapMs) {
      cursor = out[i - 1] + minGapMs;
    }
    out.push(Math.max(0, Math.floor(cursor)));
  }
  return out;
}

/**
 * Run an async handler over each item, sleeping until each item's
 * scheduled time. Returns the per-item handler results so callers can
 * count restored vs failed.
 *
 * @param {object} cfg
 * @param {Array<*>}                cfg.items
 * @param {number}                  cfg.windowMs        Total time window (ms).
 * @param {number}                  cfg.perMinuteCap    Max items per rolling 60 s.
 * @param {(item:any) => Promise<*>} cfg.handler
 * @param {(idx:number,total:number,delayMs:number)=>void} [cfg.onProgress]
 * @returns {Promise<Array<{item:*, ok:boolean, value?:any, error?:any, delayMs:number}>>}
 */
async function run(cfg) {
  const items = Array.isArray(cfg.items) ? cfg.items : [];
  const total = items.length;
  if (total === 0) return [];
  const windowMs = Math.max(0, Number(cfg.windowMs) || 0);
  const perMinuteCap = Math.max(0, Number(cfg.perMinuteCap) || 0);
  const handler = typeof cfg.handler === 'function' ? cfg.handler : async () => {};
  const onProgress = typeof cfg.onProgress === 'function' ? cfg.onProgress : null;

  const schedule = buildSchedule(total, windowMs, perMinuteCap);
  const startedAt = Date.now();
  const results = new Array(total);

  for (let i = 0; i < total; i++) {
    const elapsed = Date.now() - startedAt;
    const wait = Math.max(0, schedule[i] - elapsed);
    if (wait > 0) await _sleep(wait);

    const item = items[i];
    if (onProgress) {
      try { onProgress(i, total, schedule[i]); } catch { /* ignore */ }
    }
    try {
      const value = await handler(item, i, total);
      results[i] = { item, ok: true, value, delayMs: schedule[i] };
    } catch (error) {
      logger.warn(`restoreScheduler item ${i + 1}/${total} failed: ${error.message}`);
      results[i] = { item, ok: false, error, delayMs: schedule[i] };
    }
  }

  return results;
}

module.exports = {
  run,
  buildSchedule,
};
