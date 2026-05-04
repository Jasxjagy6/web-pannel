/**
 * On-disk state for the upgrade orchestrator.
 *
 * Stored at `state/active-color.json` (gitignored). This is the single source
 * of truth for "which color is currently serving traffic" between deploy
 * runs. The matching record in the `deployments` table is for audit; this
 * file is for runtime decisions when the DB is unreachable (rare).
 *
 * Layout:
 * {
 *   "color":         "blue" | "green",
 *   "image":         "web-pannel-backend:abcdef0",
 *   "git_sha":       "abcdef0123...",
 *   "git_ref":       "main",
 *   "deployed_at":   "2026-05-04T03:18:00Z",
 *   "previous": { ...same shape, the snapshot replaced on this deploy }
 * }
 */

const fs = require('fs');
const path = require('path');

const STATE_DIR = process.env.UPGRADE_STATE_DIR
  || path.join(__dirname, '..', '..', 'state');
const STATE_FILE = path.join(STATE_DIR, 'active-color.json');
const LOCK_FILE = path.join(STATE_DIR, 'upgrade.lock');

function ensureDir() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

function readState() {
  ensureDir();
  if (!fs.existsSync(STATE_FILE)) {
    return {
      color: 'blue',
      image: null,
      git_sha: null,
      git_ref: null,
      deployed_at: null,
      previous: null,
    };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (err) {
    throw new Error(`active-color.json is corrupt (${err.message}); inspect ${STATE_FILE}`);
  }
}

function writeState(next) {
  ensureDir();
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function inactiveColor(active) {
  return active === 'blue' ? 'green' : 'blue';
}

/**
 * Acquire an exclusive lock so two simultaneous deploys can't race. Uses
 * `O_EXCL` so the create-file is atomic on POSIX. Returns a release function.
 */
function acquireLock() {
  ensureDir();
  let fd;
  try {
    fd = fs.openSync(LOCK_FILE, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') {
      let owner = 'unknown';
      try { owner = fs.readFileSync(LOCK_FILE, 'utf8').trim(); } catch (_) {}
      throw new Error(
        `another upgrade is in progress (lock held by ${owner}). ` +
        `Remove ${LOCK_FILE} only after confirming no deploy is running.`
      );
    }
    throw err;
  }
  fs.writeSync(fd, `pid=${process.pid} started=${new Date().toISOString()}\n`);
  fs.closeSync(fd);
  return function release() {
    try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
  };
}

module.exports = {
  STATE_DIR,
  STATE_FILE,
  LOCK_FILE,
  readState,
  writeState,
  inactiveColor,
  acquireLock,
};
