#!/usr/bin/env node
/**
 * ig-export-session.js — Generate an Instagram session JSON for the panel.
 *
 * Run this on a machine that's *already trusted* by Instagram (your
 * laptop / home network), where logging in won't trip the
 * "suspicious login" device check that data-centre IPs hit. Then
 * upload the resulting JSON file to /instagram/upload-session in the
 * panel.
 *
 * Usage
 * -----
 *   node scripts/ig-export-session.js \
 *     --username YOUR_USERNAME \
 *     --password 'YOUR_PASSWORD' \
 *     --out      ./session.json
 *
 * Options
 * -------
 *   --username   Instagram username (required)
 *   --password   Instagram password (required)
 *   --otp        2FA code (if account uses 2FA — script will prompt if omitted)
 *   --proxy      proxyUrl (optional, e.g. http://user:pass@host:port)
 *   --out        Output file path (default: ./session.json)
 *   --pretty     Pretty-print the JSON (default: true)
 *
 * Output format matches what /api/instagram/sessions/upload expects:
 *   { username, sessionBlob: {...}, proxyUrl: null }
 *
 * Then in the panel:
 *   /instagram/upload-session  →  drag the JSON into the drop zone  →  done.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function ask(question, { silent = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (silent) {
      // Best-effort hide input (works on most TTYs)
      const stdin = process.openStdin();
      const onData = (ch) => {
        ch = String(ch);
        if (ch === '\n' || ch === '\r' || ch === '\u0004') {
          stdin.removeListener('data', onData);
        } else {
          process.stdout.clearLine(0);
          readline.cursorTo(process.stdout, 0);
          process.stdout.write(question + '*'.repeat(rl.line.length));
        }
      };
      stdin.on('data', onData);
    }
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || args.h) {
    console.log(fs.readFileSync(__filename, 'utf8').match(/\/\*\*[\s\S]*?\*\//)[0]);
    process.exit(0);
  }

  const username = args.username || (await ask('Instagram username: '));
  const password = args.password || (await ask('Instagram password: ', { silent: true }));
  const proxyUrl = args.proxy || null;
  const outPath = path.resolve(args.out || './session.json');

  if (!username || !password) {
    console.error('username + password are required.');
    process.exit(2);
  }

  // Try to load the IG library from the same node_modules the backend
  // uses so we don't force a separate `npm install` for the operator.
  let IgApiClient;
  let IgLoginTwoFactorRequiredError;
  let IgCheckpointError;
  try {
    const mod = require(path.resolve(__dirname, '../backend/node_modules/instagram-private-api'));
    IgApiClient = mod.IgApiClient;
    IgLoginTwoFactorRequiredError = mod.IgLoginTwoFactorRequiredError;
    IgCheckpointError = mod.IgCheckpointError;
  } catch (_) {
    try {
      const mod = require('instagram-private-api');
      IgApiClient = mod.IgApiClient;
      IgLoginTwoFactorRequiredError = mod.IgLoginTwoFactorRequiredError;
      IgCheckpointError = mod.IgCheckpointError;
    } catch (e) {
      console.error('Could not find instagram-private-api. Run `npm install` in backend/ first.');
      process.exit(2);
    }
  }

  const ig = new IgApiClient();
  ig.state.generateDevice(username.toLowerCase());
  if (proxyUrl) ig.state.proxyUrl = proxyUrl;

  console.log(`[ig-export] logging in as @${username}…`);

  // Pre-login flow makes IG's API happier.
  try { await ig.simulate.preLoginFlow(); } catch (_) { /* non-fatal */ }

  let me;
  try {
    me = await ig.account.login(username, password);
  } catch (err) {
    if (err && err.constructor && err.constructor.name === 'IgLoginTwoFactorRequiredError') {
      const info = err.response.body.two_factor_info;
      const otp = args.otp || (await ask('Enter 2FA code: '));
      if (!otp) {
        console.error('2FA code required.');
        process.exit(3);
      }
      me = await ig.account.twoFactorLogin({
        username: info.username,
        verificationCode: otp,
        twoFactorIdentifier: info.two_factor_identifier,
        verificationMethod: '1',
        trustThisDevice: '1',
      });
    } else if (err && err.constructor && err.constructor.name === 'IgCheckpointError') {
      console.error('Instagram triggered a checkpoint challenge. Resolve it in the IG app first, then re-run this script.');
      process.exit(4);
    } else {
      console.error('Login failed:', err.message || err);
      process.exit(5);
    }
  }

  // Pretend we're a real human after logging in.
  try { await ig.simulate.postLoginFlow(); } catch (_) { /* non-fatal */ }

  const cookieJson = JSON.parse(await ig.state.serializeCookieJar());
  const sessionBlob = {
    cookies: cookieJson,
    deviceString: ig.state.deviceString,
    deviceId: ig.state.deviceId,
    uuid: ig.state.uuid,
    phoneId: ig.state.phoneId,
    adid: ig.state.adid,
    build: ig.state.build,
  };

  const record = {
    username,
    sessionBlob,
    proxyUrl,
  };

  const json = args.pretty === false
    ? JSON.stringify(record)
    : JSON.stringify(record, null, 2);

  fs.writeFileSync(outPath, json + '\n', 'utf8');
  console.log(`[ig-export] wrote ${outPath}`);
  console.log(`[ig-export] logged in as @${me.username} (pk=${me.pk})`);
  console.log('[ig-export] upload this file at /instagram/upload-session in the panel.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[ig-export] unexpected error:', err);
  process.exit(1);
});
