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
  const { stdout: sha } = await run('git', ['rev-parse', `${ref}^{commit}`], {
    cwd: REPO_ROOT,
  });
  const targetSha = sha.trim();
  log(`resolved ${ref} → ${targetSha.slice(0, 12)}`);
  await run('git', ['checkout', targetSha], { cwd: REPO_ROOT });
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

  // Try to find the network of a running compose service (postgres preferred,
  // then redis). Operators can override via COMPOSE_NETWORK.
  for (const svc of ['postgres', 'redis']) {
    try {
      const { stdout } = await run(
        'docker',
        ['inspect', '--format', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}\n{{end}}', svc],
        { allowFail: true }
      );
      const first = stdout.split('\n').map((s) => s.trim()).find((s) => s && s !== 'bridge');
      if (first) return first;
    } catch (_) { /* keep trying */ }
  }

  // Heuristic: docker compose v2 default network = "<projectdir>_default".
  const dirName = path.basename(REPO_ROOT).toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${dirName}_default`;
}

/* -------------------------------------------------------------------------- */
/* Step 4 — bring up staged color                                             */
/* -------------------------------------------------------------------------- */

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

async function flipCaddy({ color, log }) {
  const caddyClient = require(path.join(PROXY_DIR, 'caddyClient'));
  const upstream = `backend-${color}:3005`;
  const cfg = caddyClient.buildConfig({
    backendUpstream: upstream,
    frontendUpstream: 'frontend:83',
    publicDomain: process.env.PUBLIC_DOMAIN || '',
    acmeEmail: process.env.ACME_EMAIL || '',
  });
  log(`pushing Caddy config → ${upstream}`);
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

function persistActiveState({ color, sha, ref, imageTag, prev }) {
  const next = {
    color,
    image: imageTag,
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
  REPO_ROOT,
};
