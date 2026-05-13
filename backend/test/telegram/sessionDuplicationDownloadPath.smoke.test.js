/**
 * Smoke test for the clone-export download-path regression.
 *
 * Production logs (2026-05-13) showed every download attempt 500ing
 * with `TypeError: path must be absolute or specify root to
 * res.sendFile`. Root cause: `UPLOAD_DIR` is set to a *relative* path
 * (`./uploads` in `backend/.env.example` and in the deployed env), so
 * `stageRoot`, `stageDir`, and the final `clone-export-<id>.zip` path
 * were all relative. Express's `res.sendFile` rejects that.
 *
 * This test pins the fix: with a RELATIVE `UPLOAD_DIR`, the zip path
 * surfaced by the service is still ABSOLUTE — both directly via
 * `getJobZipPath` and reflected back in the public job view.
 *
 * Runs the service in a child process so we can set `UPLOAD_DIR`
 * BEFORE any require() captures it. The parent test process keeps
 * its own (absolute) tmp dir for cleanup.
 */

'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

async function main() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'panel-clone-export-cwd-'));
  const relDir = './uploads-clone-rel';

  const script = `
    'use strict';
    const assert = require('assert');
    const path = require('path');
    const Module = require('module');

    // Mock 'telegram' so the service loads without GramJS realities.
    const fakeApi = {
      auth: {
        ExportLoginToken: function () { return { __type: 'auth.ExportLoginToken' }; },
        AcceptLoginToken: function () { return { __type: 'auth.AcceptLoginToken' }; },
        ImportLoginToken: function () { return { __type: 'auth.ImportLoginToken' }; },
        CheckPassword: function () { return { __type: 'auth.CheckPassword' }; },
        LoginToken: class {},
        LoginTokenMigrateTo: class {},
        LoginTokenSuccess: class {},
        Authorization: class {},
      },
      account: { GetPassword: function () { return {}; } },
      users: { GetFullUser: function () { return {}; } },
      InputUserSelf: function () { return {}; },
    };
    const fakeTelegram = { Api: fakeApi, TelegramClient: class {} };
    const fakeSessions = { StringSession: class { constructor(s) { this._s = s||''; } save() { return this._s; } } };
    const fakePassword = { computeCheck: async () => ({}) };

    const origLoad = Module._load;
    Module._load = function (request, parent, ...rest) {
      if (request === 'telegram') return fakeTelegram;
      if (request === 'telegram/sessions') return fakeSessions;
      if (request === 'telegram/Password') return fakePassword;
      return origLoad.call(this, request, parent, ...rest);
    };

    // Mock the DB pool the service touches at startup-time.
    require.cache[require.resolve(${JSON.stringify(path.resolve(__dirname, '../../src/config/database.js'))})] = {
      exports: { pool: { query: async () => ({ rows: [] }) } },
      id: 'mockdb', filename: 'mockdb', loaded: true,
    };
    // Mock the inner telegramService import so the service loads cleanly.
    require.cache[require.resolve(${JSON.stringify(path.resolve(__dirname, '../../src/services/telegramService.js'))})] = {
      exports: { _ensureConnected: async () => {}, _getClient: () => null },
      id: 'mocktg', filename: 'mocktg', loaded: true,
    };

    // The whole point of this test: load the service AFTER setting a
    // relative UPLOAD_DIR. The service must still resolve to absolute
    // on its own.
    process.env.UPLOAD_DIR = ${JSON.stringify(relDir)};

    const service = require(${JSON.stringify(path.resolve(__dirname, '../../src/services/sessionDuplicationService.js'))});

    (async () => {
      const { jobId } = await service.startCloneJob({
        userId: 1,
        sessionIds: [12345],
        destApiId: 22222,
        destApiHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        interSessionDelayMs: 0,
      });
      // We don't care if the clone succeeds — only that the job
      // exists with an absolute stageDir / (eventual) zipPath.
      const view = service.getJobStatus(jobId, 1);
      assert.ok(view, 'job view should exist');
      // Wait briefly to let the loop fail-fast on the unmocked clone.
      await new Promise(r => setTimeout(r, 50));
      // Force build the zip even if the row failed: the service does
      // it at the end of runJob unconditionally (except on cancel).
      for (let i = 0; i < 60; i++) {
        const v = service.getJobStatus(jobId, 1);
        if (v.status === 'completed' || v.status === 'failed') break;
        await new Promise(r => setTimeout(r, 25));
      }
      const zipPath = service.getJobZipPath(jobId, 1);
      assert.ok(zipPath, 'expected a zip path to be set after run');
      assert.ok(
        path.isAbsolute(zipPath),
        'zipPath must be ABSOLUTE so Express res.sendFile accepts it. Got: ' + zipPath
      );
      console.log('clone-export download-path: ABSOLUTE ok (' + zipPath + ')');
    })().catch((err) => {
      console.error(err && err.stack || err);
      process.exit(1);
    });
  `;

  const r = spawnSync(process.execPath, ['-e', script], {
    cwd,
    env: { ...process.env, UPLOAD_DIR: relDir },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) {
    console.error('child stdout:', r.stdout);
    console.error('child stderr:', r.stderr);
    throw new Error('child process failed with status ' + r.status);
  }
  // Confirm the child printed the expected success line.
  assert.ok(
    /clone-export download-path: ABSOLUTE ok/.test(r.stdout),
    'expected child to print the absolute-path success line. stdout=' + r.stdout
  );

  await fs.remove(cwd).catch(() => {});
  await fs.remove(path.resolve(cwd, relDir)).catch(() => {});
  console.log('sessionDuplicationDownloadPath.smoke.test: OK');
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
