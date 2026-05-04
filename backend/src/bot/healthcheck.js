#!/usr/bin/env node
/**
 * Docker HEALTHCHECK for the admin-bot service.
 *
 * Reads /app/state/admin-bot.heartbeat (a millisecond timestamp written by
 * adminBot.js on every long-poll iteration) and exits 0 if it's fresher
 * than HEARTBEAT_MAX_AGE_MS, otherwise 1.
 *
 * The bot has no HTTP server so we can't reuse the backend's `/health`
 * probe. The inherited Dockerfile HEALTHCHECK is overridden by the
 * compose service to call this script instead.
 */

const fs = require('fs');
const path = require('path');

const HEARTBEAT_PATH = path.join(
  process.env.STATE_DIR || '/app/state',
  'admin-bot.heartbeat'
);
const MAX_AGE_MS = parseInt(process.env.HEARTBEAT_MAX_AGE_MS || '90000', 10);

try {
  const raw = fs.readFileSync(HEARTBEAT_PATH, 'utf8');
  const ts = Number(raw);
  if (!Number.isFinite(ts)) process.exit(1);
  const age = Date.now() - ts;
  process.exit(age < MAX_AGE_MS ? 0 : 1);
} catch (_) {
  process.exit(1);
}
