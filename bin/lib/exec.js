/**
 * Tiny helpers around child_process for the orchestrator.
 *
 * - `run(cmd, args, opts)`     waits for the process, captures stdout/stderr,
 *                              throws on non-zero unless allowFail is set.
 * - `runStream(cmd, args)`     streams stdout/stderr to a writer (used by the
 *                              Telegram bot to forward progress to chat).
 * - `which(cmd)`               resolves an executable on PATH; returns null if
 *                              missing.
 */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function run(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...(opts.env || {}) };
    const child = spawn(cmd, args, {
      cwd: opts.cwd || process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || opts.allowFail) {
        resolve({ code, stdout, stderr });
      } else {
        const err = new Error(
          `${cmd} ${args.join(' ')} failed (exit ${code}): ${stderr.trim() || stdout.trim()}`
        );
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

function runStream(cmd, args = [], opts = {}) {
  const onLine = opts.onLine || (() => {});
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...(opts.env || {}) };
    const child = spawn(cmd, args, {
      cwd: opts.cwd || process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    function pump(chunk) {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        try { onLine(line); } catch (_) {}
      }
    }
    child.stdout.on('data', pump);
    child.stderr.on('data', pump);
    child.on('error', reject);
    child.on('close', (code) => {
      if (buf) try { onLine(buf); } catch (_) {}
      if (code === 0 || opts.allowFail) resolve({ code });
      else reject(new Error(`${cmd} exited ${code}`));
    });
  });
}

function which(cmd) {
  const PATH = process.env.PATH || '';
  for (const dir of PATH.split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, cmd);
    try {
      const st = fs.statSync(full);
      if (st.isFile()) return full;
    } catch (_) { /* not here */ }
  }
  return null;
}

function runSyncQuiet(cmd, args = [], opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

module.exports = { run, runStream, which, runSyncQuiet };
