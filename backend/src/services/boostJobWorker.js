'use strict';

const { pool } = require('../config/database');
const telegramService = require('./telegramService');
const logger = require('../utils/logger');

const TICK_MS = Math.max(1000, parseInt(process.env.BOOST_JOB_TICK_MS || '3000', 10));
const ACTION_DELAY_MS = Math.max(0, parseInt(process.env.BOOST_ACTION_DELAY_MS || '750', 10));

let timer = null;
let running = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function emit(userId, event, data) {
  if (global.io) global.io.to(`user:${userId}`).emit(event, data);
}

async function claimJob() {
  const { rows } = await pool.query(
    `UPDATE boost_jobs
        SET status = 'running', started_at = COALESCE(started_at, NOW())
      WHERE id = (
        SELECT id FROM boost_jobs WHERE status = 'pending'
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
      ) RETURNING *`
  );
  return rows[0] || null;
}

async function nextItem(jobId) {
  const { rows } = await pool.query(
    `UPDATE boost_job_items SET status = 'running', started_at = NOW()
      WHERE id = (
        SELECT id FROM boost_job_items
         WHERE job_id = $1 AND status = 'pending'
         ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
      ) RETURNING *`,
    [jobId]
  );
  return rows[0] || null;
}

async function finishItem(job, item, status, data = {}) {
  const applied = Number(data.appliedCount || 0);
  await pool.query(
    `UPDATE boost_job_items
        SET status = $2, applied_count = $3, available_slots = $4,
            result = $5, skip_reason = $6, error_message = $7, finished_at = NOW()
      WHERE id = $1`,
    [item.id, status, applied, Number(data.availableSlots || 0),
     JSON.stringify(data.result || {}), data.skipReason || null,
     data.error ? String(data.error).slice(0, 1000) : null]
  );
  await pool.query(
    `UPDATE boost_jobs
        SET processed_count = processed_count + 1,
            applied_count = applied_count + $2,
            failed_count = failed_count + $3,
            skipped_count = skipped_count + $4
      WHERE id = $1`,
    [job.id, applied, status === 'failed' ? 1 : 0, status === 'skipped' ? 1 : 0]
  );
  emit(job.user_id, 'boost:progress', {
    jobId: job.id,
    sessionId: item.session_id,
    status,
    appliedCount: applied,
  });
}

async function runItem(job, item) {
  try {
    const me = await telegramService.getMe(item.session_id);
    if (!me.isPremium) {
      await finishItem(job, item, 'skipped', { skipReason: 'not_premium' });
      return;
    }
    const slotState = await telegramService.getMyBoostSlots(item.session_id);
    const slots = slotState.slots.filter((slot) => slot.available).map((slot) => slot.slot);
    if (!slots.length) {
      await finishItem(job, item, 'skipped', {
        skipReason: slotState.cooldown ? 'slots_in_cooldown' : 'no_available_slots',
        result: { slotState },
      });
      return;
    }

    const targets = Array.isArray(job.targets) ? job.targets : [];
    const assignments = targets.map((target) => ({ target, slots: [] }));
    slots.forEach((slot, index) => assignments[index % assignments.length].slots.push(slot));
    const results = [];
    let appliedCount = 0;
    for (const assignment of assignments) {
      if (!assignment.slots.length) continue;
      try {
        const result = await telegramService.applyBoostSlots(
          item.session_id,
          assignment.target,
          assignment.slots
        );
        appliedCount += assignment.slots.length;
        results.push({ success: true, ...result });
      } catch (error) {
        results.push({
          success: false,
          target: assignment.target,
          slots: assignment.slots,
          error: error.message,
          code: error.code || null,
        });
      }
      if (ACTION_DELAY_MS) await sleep(ACTION_DELAY_MS);
    }

    await finishItem(job, item, appliedCount > 0 ? 'boosted' : 'failed', {
      appliedCount,
      availableSlots: slots.length,
      result: { slotState, targets: results },
      error: appliedCount === 0 ? 'No target could be boosted' : null,
    });
  } catch (error) {
    const message = error?.message || String(error);
    const notPremium = /PREMIUM|BOOSTS_EMPTY/i.test(message);
    await finishItem(job, item, notPremium ? 'skipped' : 'failed', {
      skipReason: notPremium ? 'not_premium' : null,
      error: message,
    });
  }
}

async function cancelRemaining(job) {
  const { rowCount } = await pool.query(
    `UPDATE boost_job_items SET status = 'skipped', skip_reason = 'cancelled', finished_at = NOW()
      WHERE job_id = $1 AND status = 'pending'`,
    [job.id]
  );
  if (rowCount) {
    await pool.query(
      `UPDATE boost_jobs
          SET processed_count = processed_count + $2, skipped_count = skipped_count + $2
        WHERE id = $1`,
      [job.id, rowCount]
    );
  }
}

async function processJob(job) {
  try {
    while (true) {
      const { rows } = await pool.query(`SELECT cancel_requested FROM boost_jobs WHERE id = $1`, [job.id]);
      if (rows[0]?.cancel_requested) {
        await cancelRemaining(job);
        await pool.query(`UPDATE boost_jobs SET status = 'cancelled', finished_at = NOW() WHERE id = $1`, [job.id]);
        emit(job.user_id, 'boost:completed', { jobId: job.id, status: 'cancelled' });
        return;
      }
      const item = await nextItem(job.id);
      if (!item) break;
      await runItem(job, item);
    }

    const { rows } = await pool.query(`SELECT applied_count, failed_count, skipped_count FROM boost_jobs WHERE id = $1`, [job.id]);
    const counts = rows[0] || {};
    const status = Number(counts.applied_count) > 0 || Number(counts.failed_count) === 0 ? 'completed' : 'failed';
    await pool.query(`UPDATE boost_jobs SET status = $2, finished_at = NOW() WHERE id = $1`, [job.id, status]);
    emit(job.user_id, 'boost:completed', { jobId: job.id, status, ...counts });
  } catch (error) {
    logger.error(`Boost job ${job.id} failed: ${error.message}`);
    await pool.query(
      `UPDATE boost_jobs SET status = 'failed', error_message = $2, finished_at = NOW() WHERE id = $1`,
      [job.id, String(error.message).slice(0, 1000)]
    ).catch(() => {});
    emit(job.user_id, 'boost:failed', { jobId: job.id, error: error.message });
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    while (true) {
      const job = await claimJob();
      if (!job) break;
      await processJob(job);
    }
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  pool.query(`UPDATE boost_job_items SET status = 'pending', started_at = NULL WHERE status = 'running'`)
    .then(() => pool.query(`UPDATE boost_jobs SET status = 'pending', started_at = NULL WHERE status = 'running'`))
    .catch((error) => logger.warn(`Boost worker recovery failed: ${error.message}`))
    .finally(() => {
      timer = setInterval(() => tick().catch((error) => logger.error(`Boost worker tick failed: ${error.message}`)), TICK_MS);
      if (timer.unref) timer.unref();
      tick().catch(() => {});
      logger.info(`Boost job worker started (tick=${TICK_MS}ms)`);
    });
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, runSweepOnce: tick };
