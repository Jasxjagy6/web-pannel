/**
 * In-process readiness flags.
 *
 * Each probe represents a piece of the boot path that the upgrade
 * orchestrator must wait for before flipping traffic to a new color.
 *
 * Defaults: every probe starts `false`. The owner module flips it via
 * `markReady(name)` when it finishes initializing.
 *
 * Probes:
 *   - queues:     BullMQ queues constructed in `src/queues/index.js`.
 *   - sessions:   `restoreAllLoggedInSessions()` finished its first pass.
 *   - workers:    background workers (privacy, behavior, monitor sweep,
 *                 subscription expiry) launched.
 *
 * The list is intentionally small. New surfaces should add a probe here AND
 * call `markReady(...)` from their boot path.
 */

const STARTED_AT = new Date().toISOString();

const probes = {
  queues: false,
  sessions: false,
  workers: false,
};

function markReady(name) {
  if (!(name in probes)) {
    // Allow ad-hoc probes; warn so we know they exist.
    probes[name] = false;
  }
  probes[name] = true;
}

function markNotReady(name) {
  probes[name] = false;
}

function snapshot() {
  return { ...probes };
}

function isReady() {
  return Object.values(probes).every(Boolean);
}

function startedAt() {
  return STARTED_AT;
}

module.exports = { markReady, markNotReady, snapshot, isReady, startedAt };
