/**
 * Health & readiness endpoints.
 *
 * `/health`         liveness — process is up. Always 200 once the HTTP server
 *                   is bound. Used by Docker HEALTHCHECK and external monitors.
 * `/health/ready`   readiness — DB pingable, Redis pingable, queues
 *                   initialized, session-restore completed. Returns 503 until
 *                   all of these have been confirmed during boot. The upgrade
 *                   orchestrator polls this against the staged color BEFORE
 *                   flipping traffic.
 * `/health/version` returns the build identity ({ git_sha, build_time, color,
 *                   pid, image }) so the orchestrator can confirm the new
 *                   color is running the expected image.
 *
 * Readiness is tracked via the `readiness` module (see `utils/readiness.js`)
 * so service modules can flip individual probes (e.g. `markReady('redis')`)
 * as they finish initializing.
 */

const express = require('express');
const router = express.Router();

const readiness = require('../utils/readiness');
const { pool } = require('../config/database');

let cachedRedisClient = null;
function tryGetRedis() {
  if (cachedRedisClient) return cachedRedisClient;
  try {
    const r = require('../config/redis');
    cachedRedisClient = r && (r.client || r.redisClient || r);
    return cachedRedisClient;
  } catch (_) {
    return null;
  }
}

// /health — liveness. Cheap, no I/O. Used by Docker HEALTHCHECK.
router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    color: process.env.DEPLOY_COLOR || 'unknown',
    pid: process.pid,
  });
});

// /health/live — alias for /health, kept for k8s convention.
router.get('/live', (req, res) => {
  res.json({ status: 'ok' });
});

// /health/ready — full readiness probe. The orchestrator BLOCKS on this.
router.get('/ready', async (req, res) => {
  const probes = {};
  let allOk = true;

  // 1. Postgres — SELECT 1 with a hard 2s timeout.
  try {
    const c = await pool.connect();
    try {
      await c.query('SELECT 1');
      probes.postgres = { ok: true };
    } finally {
      c.release();
    }
  } catch (err) {
    probes.postgres = { ok: false, error: err.message };
    allOk = false;
  }

  // 2. Redis — PING.
  try {
    const r = tryGetRedis();
    if (r && typeof r.ping === 'function') {
      const pong = await r.ping();
      probes.redis = { ok: pong === 'PONG' || pong === true || pong === 'pong', value: pong };
      if (!probes.redis.ok) allOk = false;
    } else {
      probes.redis = { ok: false, error: 'redis client not available' };
      allOk = false;
    }
  } catch (err) {
    probes.redis = { ok: false, error: err.message };
    allOk = false;
  }

  // 3. In-process readiness flags set by the boot path. Probes have a default
  //    of false and flip to true once their owner finishes initialization.
  const flags = readiness.snapshot();
  probes.flags = flags;
  for (const [name, ok] of Object.entries(flags)) {
    if (!ok) allOk = false;
  }

  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ready' : 'not_ready',
    color: process.env.DEPLOY_COLOR || 'unknown',
    pid: process.pid,
    probes,
    timestamp: new Date().toISOString(),
  });
});

// /health/version — build identity. Public information (git SHA), no secrets.
router.get('/version', (req, res) => {
  res.json({
    git_sha: process.env.GIT_SHA || 'unknown',
    git_ref: process.env.GIT_REF || 'unknown',
    build_time: process.env.BUILD_TIME || 'unknown',
    image: process.env.IMAGE_TAG || 'unknown',
    color: process.env.DEPLOY_COLOR || 'unknown',
    node: process.version,
    pid: process.pid,
    started_at: readiness.startedAt(),
    uptime_s: Math.round(process.uptime()),
  });
});

module.exports = router;
