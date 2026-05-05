/**
 * Deploy steps for `bin/upgrade`.
 *
 * The orchestrator chains these in order; on any failure it stops and the
 * top-level `upgrade.js` triggers cleanup (stop the staged color, leave
 * traffic on the active color, write the failure to audit + Telegram).
 *
 * Each step is short and side-effecty so progress can be streamed back to
 * the operator (CLI stdout or Telegram chat).
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { run, runStream } = require('./exec');
const audit = require('./audit');
const stateMod = require('./state');

const REPO_ROOT = path.join(__dirname, '..', '..');
const PROXY_DIR = path.join(REPO_ROOT, 'proxy');

const COMPOSE_BIN = process.env.COMPOSE_BIN || 'docker';
const COMPOSE_ARGS_BASE = process.env.COMPOSE_BIN
  ? [] // operator overrode with e.g. `docker-compose`
  : ['compose'];

function compose(args, opts = {}) {
  return run(COMPOSE_BIN, [...COMPOSE_ARGS_BASE, ...args], { cwd: REPO_ROOT, ...opts });
}

function composeStream(args, onLine, opts = {}) {
  return runStream(COMPOSE_BIN, [...COMPOSE_ARGS_BASE, ...args], {
    cwd: REPO_ROOT,
    onLine,
    ...opts,
  });
}

/* -------------------------------------------------------------------------- */
/* Step 1 — git checkout                                                      */
/* -------------------------------------------------------------------------- */

async function gitFetchAndCheckout(ref, log) {
  log(`git fetch origin (ref=${ref})`);
  await run('git', ['fetch', 'origin', '--tags', '--prune'], { cwd: REPO_ROOT });

  // Resolve the ref to a SHA so we know exactly what we're deploying.
  //
  // Prefer the remote-tracking ref over the local one: an operator running
  // `bin/upgrade deploy --ref main` almost always means "the latest main on
  // GitHub", not whatever stale commit their local main happens to be on.
  // Local main is only updated by `git pull` / `git merge`; `git fetch`
  // alone only moves `origin/main`. Without this, a user who pushed a fix
  // to GitHub but didn't pull locally would silently re-deploy the OLD
  // commit, then assume the upgrade system is broken when in fact the
  // fix simply never reached the running container.
  //
  // We try in order: `origin/<ref>` (matches a remote-tracking branch),
  // then `<ref>` (matches a tag, an explicit SHA, or a local branch that
  // doesn't exist on origin). The `^{commit}` peel guards against
  // resolving to an annotated tag object instead of a commit.
  const candidates = [`origin/${ref}`, ref];
  let targetSha = null;
  let resolvedFrom = null;
  for (const candidate of candidates) {
    const r = await run('git', ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], {
      cwd: REPO_ROOT,
      allowFail: true,
    });
    if (r.code === 0 && r.stdout && r.stdout.trim()) {
      targetSha = r.stdout.trim();
      resolvedFrom = candidate;
      break;
    }
  }
  if (!targetSha) {
    throw new Error(
      `unable to resolve ref="${ref}" to a commit SHA ` +
      `(tried ${candidates.map((c) => `"${c}"`).join(', ')}). ` +
      `Make sure the branch/tag exists on origin or pass an explicit SHA.`
    );
  }
  log(`resolved ${resolvedFrom} → ${targetSha.slice(0, 12)}`);

  // `git checkout <sha>` blows up with "Your local changes would be
  // overwritten" when the working tree has uncommitted edits — even if
  // those edits are completely unrelated to the upgrade. Operators iterate
  // on configs/scripts in-place all the time, so this would routinely
  // brick deploys with a confusing error. Stash any tracked-file changes
  // before the checkout and restore them after, so the working tree
  // round-trips cleanly. Untracked files are left alone (--keep-index
  // would be wrong here — we want a clean checkout target).
  const { stdout: dirtyStatus } = await run(
    'git',
    ['status', '--porcelain', '--untracked-files=no'],
    { cwd: REPO_ROOT, allowFail: true }
  );
  let stashRef = null;
  if (dirtyStatus && dirtyStatus.trim()) {
    log('working tree has local changes — stashing before checkout');
    const stashName = `bin/upgrade-${Date.now()}`;
    const r = await run(
      'git',
      ['stash', 'push', '--include-untracked', '-m', stashName],
      { cwd: REPO_ROOT, allowFail: true }
    );
    if (r.code === 0 && r.stdout && !r.stdout.includes('No local changes')) {
      stashRef = stashName;
    }
  }

  await run('git', ['checkout', targetSha], { cwd: REPO_ROOT });

  if (stashRef) {
    log(`restoring stashed local changes (${stashRef})`);
    // best-effort: don't abort the deploy if the stash pop runs into
    // conflicts — those are the operator's to resolve after the fact.
    await run('git', ['stash', 'pop'], { cwd: REPO_ROOT, allowFail: true });
  }

  return targetSha;
}

/* -------------------------------------------------------------------------- */
/* Step 2 — image build / pull                                                */
/* -------------------------------------------------------------------------- */

async function buildOrPullImage({ buildMode, registry, sha, log }) {
  const tag = `web-pannel-backend:${sha.slice(0, 12)}`;
  if (buildMode === 'registry') {
    const remote = `${registry}:${sha.slice(0, 12)}`;
    log(`pulling ${remote}`);
    await run('docker', ['pull', remote]);
    log(`tagging ${remote} → ${tag}`);
    await run('docker', ['tag', remote, tag]);
  } else {
    log(`building ${tag} (this can take a couple of minutes the first time)…`);
    await composeStream(
      [
        'build',
        '--build-arg', `GIT_SHA=${sha}`,
        '--build-arg', `BUILD_TIME=${new Date().toISOString()}`,
        '--build-arg', `IMAGE_TAG=${tag}`,
        'backend-blue', // either color works — same image
      ],
      (line) => log(`  build: ${line}`),
      { env: { ...process.env, IMAGE_TAG: sha.slice(0, 12), GIT_SHA: sha } }
    );
    // Ensure the image is tagged with the friendly name as well.
    await run('docker', ['tag', `web-pannel-backend:${sha.slice(0, 12)}`, tag], {
      allowFail: true,
    });
  }
  return tag;
}

/* -------------------------------------------------------------------------- */
/* Step 3 — DB migrations                                                     */
/* -------------------------------------------------------------------------- */

async function runMigrations({ imageTag, sha, dbEnv, log, mode = 'apply' }) {
  // Use a one-shot container based on the new image. This way migrations are
  // run by the SAME code that's about to start serving requests.
  const network = await composeNetworkName();
  const args = [
    'run', '--rm',
    '--network', network,
    '-e', `DB_HOST=${dbEnv.host}`,
    '-e', `DB_PORT=${dbEnv.port}`,
    '-e', `DB_NAME=${dbEnv.name}`,
    '-e', `DB_USER=${dbEnv.user}`,
    '-e', `DB_PASSWORD=${dbEnv.password}`,
    imageTag,
    'node', 'bin/migrate.js', `--${mode}`,
  ];
  log(`running migrations (mode=${mode}, network=${network})`);
  const { stdout } = await run('docker', args, { allowFail: mode === 'check' });
  for (const line of stdout.trim().split('\n')) if (line) log(`  migrate: ${line}`);
}

/**
 * Resolve the docker network the postgres service is attached to. Prefer
 * COMPOSE_NETWORK env var; otherwise inspect the running postgres container
 * for the first non-bridge network. Falls back to the directory-name guess.
 */
async function composeNetworkName() {
  if (process.env.COMPOSE_NETWORK) return process.env.COMPOSE_NETWORK;

  // Ask docker compose itself which container backs the postgres service,
  // then inspect that container's networks. Falls through to the next
  // service / heuristic on any error. This is the most reliable path
  // because it handles arbitrary COMPOSE_PROJECT_NAME settings, multi-
  // network setups, and external networks.
  for (const svc of ['postgres', 'redis']) {
    try {
      const { stdout: cid } = await run(
        'docker',
        ['compose', 'ps', '-q', svc],
        { allowFail: true, cwd: REPO_ROOT }
      );
      const containerId = cid.trim().split('\n')[0];
      if (!containerId) continue;
      const { stdout } = await run(
        'docker',
        ['inspect', '--format', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}\n{{end}}', containerId],
        { allowFail: true }
      );
      const first = stdout.split('\n').map((s) => s.trim()).find((s) => s && s !== 'bridge');
      if (first) return first;
    } catch (_) { /* keep trying */ }
  }

  // In-container fallback: when bin/upgrade runs from inside the admin-bot
  // container, REPO_ROOT is /host (the bind-mounted host repo) and `docker
  // compose ps` above silently returns nothing because compose derives the
  // project name from the cwd basename ('host'), which doesn't match the
  // host project ('web-pannel' or whatever the operator's clone dir is).
  // The admin-bot is itself attached to the same compose default network as
  // postgres/redis, so we can simply read our own networks.
  if (isInsideContainer()) {
    try {
      const hostname = fs.readFileSync('/etc/hostname', 'utf8').trim();
      const { stdout } = await run(
        'docker',
        ['inspect', '--format', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}\n{{end}}', hostname],
        { allowFail: true }
      );
      const first = stdout.split('\n').map((s) => s.trim()).find((s) => s && s !== 'bridge');
      if (first) return first;
    } catch (_) { /* fall through */ }
  }

  // Heuristic fallback: docker compose v2 default network = "<project>_default".
  // Compose v2 sanitises project names to lowercase + alphanumerics +
  // underscores + hyphens; hyphens are PRESERVED. Match that rule exactly.
  const dirName = path.basename(REPO_ROOT).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return `${dirName}_default`;
}

function isInsideContainer() {
  try { return fs.existsSync('/.dockerenv'); } catch (_) { return false; }
}

/* -------------------------------------------------------------------------- */
/* Step 4 — bring up staged color                                             */
/* -------------------------------------------------------------------------- */

/**
 * Best-effort lookup of the image currently running for `backend-<color>`.
 * Used to seed `previous` on the very first orchestrator deploy when
 * `state/active-color.json` was created with null fields. Returns null when
 * the container isn't running or docker is unavailable \u2014 the caller treats
 * that as "no rollback target", which is correct.
 */
async function runningImageOf(color) {
  try {
    const { stdout: cid } = await run(
      'docker',
      ['compose', 'ps', '-q', `backend-${color}`],
      { allowFail: true, cwd: REPO_ROOT }
    );
    const containerId = (cid || '').trim().split('\n')[0];
    if (!containerId) return null;
    const { stdout } = await run(
      'docker',
      ['inspect', '--format', '{{.Config.Image}}', containerId],
      { allowFail: true }
    );
    const img = (stdout || '').trim();
    return img || null;
  } catch (_) {
    return null;
  }
}

async function startColor({ color, sha, log }) {
  log(`starting backend-${color}`);
  await composeStream(
    ['--profile', color, 'up', '-d', `backend-${color}`],
    (line) => log(`  compose: ${line}`),
    {
      env: {
        ...process.env,
        IMAGE_TAG: sha.slice(0, 12),
        GIT_SHA: sha,
        BUILD_TIME: new Date().toISOString(),
      },
    }
  );
}

async function stopColor({ color, log }) {
  log(`stopping backend-${color}`);
  await compose(['stop', `backend-${color}`], { allowFail: true });
}

/* -------------------------------------------------------------------------- */
/* Frontend blue/green                                                        */
/* -------------------------------------------------------------------------- */
/*                                                                            */
/* The frontend is a static SPA bundle served by nginx — there's no DB, no    */
/* Redis, no live MTProto state to preserve. We still run it blue/green for   */
/* the same reason as the backend: the public URL must never serve a stale    */
/* or half-built bundle during a deploy. Each color's container holds a       */
/* snapshot of the SPA built from the deploy's git SHA.                       */

/**
 * Build the frontend SPA image. Always builds locally — the frontend's
 * dependency graph is small (no native modules, no migrations) so a cold
 * `npm install` + Vite build runs in well under a minute on the deploy
 * host. We also don't push frontend images to GHCR, so there's no
 * `--build registry` mode to support.
 *
 * Returns the image tag so the orchestrator can persist it in
 * state/active-color.json for later reference / rollback.
 */
async function buildFrontendImage({ sha, log }) {
  const tag = `web-pannel-frontend:${sha.slice(0, 12)}`;
  log(`building ${tag} (frontend SPA)…`);
  await composeStream(
    [
      'build',
      '--build-arg', `GIT_SHA=${sha}`,
      '--build-arg', `BUILD_TIME=${new Date().toISOString()}`,
      'frontend-blue', // either color works — same image
    ],
    (line) => log(`  build: ${line}`),
    {
      env: {
        ...process.env,
        FRONTEND_IMAGE_TAG: sha.slice(0, 12),
        IMAGE_TAG: process.env.IMAGE_TAG || sha.slice(0, 12),
        GIT_SHA: sha,
      },
    }
  );
  return tag;
}

/**
 * One-time migration: stop the legacy single-`frontend` container that
 * pre-dates the blue/green frontend topology. The new docker-compose.yml
 * removes the `frontend` service entirely, so `docker compose up` for the
 * blue/green services leaves the old container running side-by-side with
 * the new ones — Caddy's seed config still hard-codes `frontend:83` until
 * the orchestrator pushes a new admin config, and meanwhile both colors
 * try to bind port 83 inside their own network alias.
 *
 * Detect by container NAME (compose default = `<project>_frontend_<idx>`
 * or `<project>-frontend-<idx>`) and best-effort `docker rm -f`. We don't
 * call `docker compose down frontend` because compose v2 raises on
 * "service not in compose file" once the service block is gone.
 */
async function stopLegacyFrontend({ log }) {
  try {
    const { stdout } = await run(
      'docker',
      ['ps', '-a', '--filter', 'name=frontend', '--format', '{{.Names}}'],
      { allowFail: true }
    );
    const names = (stdout || '')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) =>
        s &&
        // Match the compose-default names but EXCLUDE the new blue/green
        // container_names, which are explicitly `web-pannel-frontend-blue`
        // and `web-pannel-frontend-green`.
        s !== 'web-pannel-frontend-blue' &&
        s !== 'web-pannel-frontend-green' &&
        /(^|[-_])frontend([-_]\d+)?$/.test(s)
      );
    for (const name of names) {
      log(`removing legacy frontend container "${name}"`);
      await run('docker', ['rm', '-f', name], { allowFail: true });
    }
  } catch (err) {
    log(`legacy frontend cleanup skipped: ${err.message}`);
  }
}

async function startFrontendColor({ color, sha, log }) {
  log(`starting frontend-${color}`);
  await composeStream(
    ['--profile', color, 'up', '-d', `frontend-${color}`],
    (line) => log(`  compose: ${line}`),
    {
      env: {
        ...process.env,
        FRONTEND_IMAGE_TAG: sha.slice(0, 12),
        IMAGE_TAG: process.env.IMAGE_TAG || sha.slice(0, 12),
        GIT_SHA: sha,
        BUILD_TIME: new Date().toISOString(),
      },
    }
  );
}

async function stopFrontendColor({ color, log }) {
  log(`stopping frontend-${color}`);
  await compose(['stop', `frontend-${color}`], { allowFail: true });
}

/**
 * Wait for the frontend container to serve "/" with a 200. nginx is
 * essentially instant once mounted, but the docker healthcheck still
 * has a start_period — we poll it directly so the orchestrator only
 * flips Caddy after the new color is actually answering HTTP.
 */
async function waitForFrontendReady({ container, timeoutMs, log }) {
  const start = Date.now();
  let lastErr = '';
  while (Date.now() - start < timeoutMs) {
    try {
      // wget is in the alpine nginx image; the busybox build is trivially
      // small, so an exec-based probe avoids opening a host port.
      const { code, stdout } = await run(
        'docker',
        ['exec', container, 'wget', '-q', '--spider', '--tries=1',
          '--timeout=2', 'http://127.0.0.1:83/'],
        { allowFail: true }
      );
      if (code === 0) {
        const ms = Date.now() - start;
        log(`  frontend "/" 200 in ${ms}ms`);
        return ms;
      }
      lastErr = stdout || lastErr;
    } catch (err) {
      lastErr = err.message;
    }
    await sleep(500);
  }
  throw new Error(`frontend ready timeout after ${timeoutMs}ms; last response: ${(lastErr || '').slice(0, 400)}`);
}

/**
 * Best-effort lookup of the frontend image currently running for a color.
 * Used to seed `previous.frontend_image` for rollback.
 */
async function runningFrontendImageOf(color) {
  try {
    const { stdout: cid } = await run(
      'docker',
      ['compose', 'ps', '-q', `frontend-${color}`],
      { allowFail: true, cwd: REPO_ROOT }
    );
    const containerId = (cid || '').trim().split('\n')[0];
    if (!containerId) return null;
    const { stdout } = await run(
      'docker',
      ['inspect', '--format', '{{.Config.Image}}', containerId],
      { allowFail: true }
    );
    const img = (stdout || '').trim();
    return img || null;
  } catch (_) {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Step 5 — wait for /health/ready                                            */
/* -------------------------------------------------------------------------- */

async function waitForReady({ container, timeoutMs, log }) {
  const start = Date.now();
  let lastErr = '';
  while (Date.now() - start < timeoutMs) {
    try {
      const { stdout } = await run(
        'docker',
        ['exec', container, 'node', '-e',
          `require('http').get('http://127.0.0.1:'+(process.env.PORT||3005)+'/health/ready',r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{process.stdout.write(b);process.exit(r.statusCode===200?0:7)})}).on('error',e=>{process.stderr.write(e.message);process.exit(8)})`
        ],
        { allowFail: true }
      );
      if (stdout && stdout.includes('"status":"ready"')) {
        const ms = Date.now() - start;
        log(`  /health/ready ok in ${ms}ms`);
        return ms;
      }
      lastErr = stdout || lastErr;
    } catch (err) {
      lastErr = err.message;
    }
    await sleep(1000);
  }
  throw new Error(`health-ready timeout after ${timeoutMs}ms; last response: ${lastErr.slice(0, 400)}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* -------------------------------------------------------------------------- */
/* Step 6 — flip Caddy upstream                                               */
/* -------------------------------------------------------------------------- */

async function flipCaddy({ color, frontendColor, log }) {
  const caddyClient = require(path.join(PROXY_DIR, 'caddyClient'));
  const backendUpstream = `backend-${color}:3005`;
  // Default the frontend color to track the backend color so deployments
  // that don't explicitly stage the frontend still publish a sane Caddy
  // config (matches the legacy single-frontend topology).
  const fColor = frontendColor || color;
  const frontendUpstream = `frontend-${fColor}:83`;
  const cfg = caddyClient.buildConfig({
    backendUpstream,
    frontendUpstream,
    publicDomain: process.env.PUBLIC_DOMAIN || '',
    acmeEmail: process.env.ACME_EMAIL || '',
  });
  log(`pushing Caddy config → backend=${backendUpstream}, frontend=${frontendUpstream}`);
  await caddyClient.loadConfig(cfg);
}

/* -------------------------------------------------------------------------- */
/* Step 7 — drain old color                                                   */
/* -------------------------------------------------------------------------- */

async function drainOldColor({ color, drainMs, log }) {
  log(`draining backend-${color} for ${drainMs}ms (lets WS clients reconnect)`);
  await sleep(drainMs);
}

/* -------------------------------------------------------------------------- */
/* Persist state                                                              */
/* -------------------------------------------------------------------------- */

function persistActiveState({
  color, sha, ref, imageTag, prev,
  frontendColor, frontendImageTag,
}) {
  const next = {
    color, // legacy alias for backend_color
    backend_color: color,
    frontend_color: frontendColor || color,
    image: imageTag,
    frontend_image: frontendImageTag || null,
    git_sha: sha,
    git_ref: ref,
    deployed_at: new Date().toISOString(),
    previous: prev,
  };
  stateMod.writeState(next);
  return next;
}

module.exports = {
  gitFetchAndCheckout,
  buildOrPullImage,
  runMigrations,
  startColor,
  stopColor,
  waitForReady,
  flipCaddy,
  drainOldColor,
  persistActiveState,
  composeNetworkName,
  runningImageOf,
  // Frontend blue/green
  buildFrontendImage,
  startFrontendColor,
  stopFrontendColor,
  waitForFrontendReady,
  runningFrontendImageOf,
  stopLegacyFrontend,
  REPO_ROOT,
};
