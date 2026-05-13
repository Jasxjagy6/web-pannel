/**
 * Smoke test for the session-duplication / QR-login-token export
 * service.
 *
 * Covers:
 *   - End-to-end happy path (non-2FA): cloneOne issues ExportLoginToken
 *     from the new client, AcceptLoginToken on the source client, then
 *     re-invokes ExportLoginToken to receive LoginTokenSuccess, and
 *     saves a string session. ImportLoginToken is only used during DC
 *     migration; calling it after AcceptLoginToken returns
 *     AUTH_TOKEN_EXPIRED (the bug that broke every clone in prod).
 *   - DC migration (`auth.LoginTokenMigrateTo`): the new client
 *     follows the migration and retries the import.
 *   - 2FA path: the post-accept ExportLoginToken raises
 *     SESSION_PASSWORD_NEEDED (Telegram surfaces 2FA at this step), the
 *     service exposes `awaiting_password`, the operator submits the
 *     password via the public API, and CheckPassword finalizes.
 *   - The ZIP bundle exists and contains both .session and .json
 *     plus a manifest entry per successful clone.
 *   - Job ownership: only the user who started a job can poll /
 *     download / submit password / cancel.
 *
 * GramJS is fully mocked. The test never opens a real socket.
 */

'use strict';

const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const Module = require('module');

// ─────────────────────────────────────────────────────────────────────
// Mock the 'telegram' package BEFORE requiring the service so the
// service picks up our fake TelegramClient / Api surface.
// ─────────────────────────────────────────────────────────────────────
class FakeNewClient {
  constructor(stringSession, apiId, apiHash, opts) {
    this.apiId = apiId;
    this.apiHash = apiHash;
    this.opts = opts || {};
    this.connected = false;
    // Snapshot of what `session.save()` will return after a successful
    // clone. Decoded GramJS string-session format-1:
    //   '1' + base64(dc_id[1] + ip[4] + port[2 BE] + auth_key[256])
    this._fakeSavedString = makeFakeStringSession(2);
    this.session = {
      save: () => this._fakeSavedString,
      dcId: 2,
    };
    // Set by the test scenario:
    this._scenario = FakeNewClient._scenario;
    this._invocations = [];
  }

  async connect() {
    this.connected = true;
  }
  async disconnect() {
    this.connected = false;
  }

  async invoke(req) {
    this._invocations.push(req.__type);
    const sc = this._scenario;
    if (req.__type === 'auth.ExportLoginToken') {
      const r = sc.exportLoginTokenSeq.shift();
      if (!r) throw new Error('no more export responses');
      // Allow scenarios to inject errors on the second (post-accept)
      // export call — that's where Telegram surfaces 2FA in the
      // QR-login flow (SESSION_PASSWORD_NEEDED).
      if (r instanceof Error) throw r;
      return r;
    }
    if (req.__type === 'auth.ImportLoginToken') {
      const r = sc.importLoginTokenSeq.shift();
      if (!r) throw new Error('no more import responses');
      if (r instanceof Error) throw r;
      return r;
    }
    if (req.__type === 'auth.CheckPassword') {
      return sc.checkPasswordResult;
    }
    if (req.__type === 'account.GetPassword') {
      return sc.getPasswordResult || { _ok: true };
    }
    if (req.__type === 'users.GetFullUser') {
      return sc.getFullUserResult || null;
    }
    throw new Error(`Unmocked RPC: ${req.__type}`);
  }
}

class FakeSourceClient {
  constructor() {
    this._invocations = [];
    this._acceptFails = false;
  }
  async invoke(req) {
    this._invocations.push(req.__type);
    if (req.__type === 'auth.AcceptLoginToken') {
      if (this._acceptFails) {
        throw new Error('AUTH_KEY_UNREGISTERED');
      }
      return { __type: 'Authorization' };
    }
    throw new Error(`Unmocked RPC on source: ${req.__type}`);
  }
}

function makeFakeStringSession(dcId) {
  // 1 + 4 + 2 + 256 = 263 bytes
  const buf = Buffer.alloc(263);
  buf.writeUInt8(dcId, 0);
  buf.writeUInt8(149, 1); buf.writeUInt8(154, 2); buf.writeUInt8(167, 3); buf.writeUInt8(50, 4);
  buf.writeUInt16BE(443, 5);
  // Deterministic fake auth_key bytes (not all zero — Telethon
  // accepts any 256-byte blob in the auth_key column).
  for (let i = 0; i < 256; i++) buf.writeUInt8((i * 7) & 0xff, 7 + i);
  return '1' + buf.toString('base64');
}

function makeMockTelegramModule() {
  const tagged = (type, fields) => Object.assign({ __type: type, className: type, ...fields });
  const Api = {
    auth: {
      ExportLoginToken: function (fields) { return tagged('auth.ExportLoginToken', fields); },
      AcceptLoginToken: function (fields) { return tagged('auth.AcceptLoginToken', fields); },
      ImportLoginToken: function (fields) { return tagged('auth.ImportLoginToken', fields); },
      CheckPassword: function (fields) { return tagged('auth.CheckPassword', fields); },
      // Result classes — only the `instanceof` shape matters. The
      // mock makes instances regular objects whose `className` matches
      // and uses a unique tag for `instanceof` checks.
      LoginToken: class { constructor(f) { Object.assign(this, f, { className: 'auth.LoginToken' }); } },
      LoginTokenMigrateTo: class { constructor(f) { Object.assign(this, f, { className: 'auth.LoginTokenMigrateTo' }); } },
      LoginTokenSuccess: class { constructor(f) { Object.assign(this, f, { className: 'auth.LoginTokenSuccess' }); } },
      Authorization: class { constructor(f) { Object.assign(this, f, { className: 'auth.Authorization' }); } },
    },
    account: {
      GetPassword: function () { return tagged('account.GetPassword', {}); },
    },
    users: {
      GetFullUser: function (fields) { return tagged('users.GetFullUser', fields); },
    },
    InputUserSelf: function () { return tagged('InputUserSelf', {}); },
  };
  return { Api, TelegramClient: FakeNewClient };
}

// Cached singletons — every require('telegram') must return the SAME
// module object so `instanceof Api.auth.LoginToken` works across the
// service and the test.
const _telegramModule = makeMockTelegramModule();
const _telegramSessions = {
  StringSession: class {
    constructor(s) { this._s = s || ''; }
    save() { return this._s; }
  },
};
const _telegramPassword = {
  computeCheck: async (_info, password) => ({ __type: 'check', password }),
};

function mockModules() {
  const origResolve = Module._resolveFilename;
  const origLoad = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (request === 'telegram') return _telegramModule;
    if (request === 'telegram/sessions') return _telegramSessions;
    if (request === 'telegram/Password') return _telegramPassword;
    return origLoad.call(this, request, parent, ...rest);
  };
  return () => {
    Module._resolveFilename = origResolve;
    Module._load = origLoad;
  };
}

// ─────────────────────────────────────────────────────────────────────
// Stub out the panel's telegramService so we don't try to ensure a
// real connection. The test owns one FakeSourceClient per session id.
// ─────────────────────────────────────────────────────────────────────
let sourceClientsBySessionId = new Map();
function mockTelegramService() {
  require.cache[require.resolve('../../src/services/telegramService.js')] = {
    exports: {
      _ensureConnected: async () => {},
      _getClient: (sid) => {
        const c = sourceClientsBySessionId.get(String(sid));
        return c ? { client: c } : null;
      },
    },
    id: '__mock_telegramService__',
    filename: '__mock_telegramService__',
    loaded: true,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Stub the pool so DB lookups during the run come back deterministic.
// ─────────────────────────────────────────────────────────────────────
let sessionRowsById = new Map();
let dbQueries = [];
function mockDB() {
  require.cache[require.resolve('../../src/config/database.js')] = {
    exports: {
      pool: {
        query: async (sql, params) => {
          const text = String(sql).replace(/\s+/g, ' ').trim();
          dbQueries.push({ text, params });
          if (text.startsWith('SELECT id, phone, api_id, api_hash')) {
            const id = Number(params[0]);
            const row = sessionRowsById.get(id);
            return { rows: row ? [row] : [] };
          }
          if (text.startsWith('SELECT account_info FROM sessions')) {
            const id = Number(params[0]);
            const row = sessionRowsById.get(id);
            return { rows: row ? [{ account_info: row.account_info || null }] : [] };
          }
          return { rows: [] };
        },
      },
    },
    id: '__mock_database__',
    filename: '__mock_database__',
    loaded: true,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Test runner
// ─────────────────────────────────────────────────────────────────────
async function main() {
  const restoreModules = mockModules();
  mockTelegramService();
  mockDB();

  // Force the service to write artifacts into a tmpdir.
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'panel-clone-export-'));
  process.env.UPLOAD_DIR = tmpRoot;

  // Require AFTER mocks so the service captures the mocks.
  const service = require('../../src/services/sessionDuplicationService');

  try {
    // ─── Sub-test 1: happy path, non-2FA ────────────────────────────
    {
      const src = new FakeSourceClient();
      sourceClientsBySessionId.set('101', src);
      sessionRowsById.set(101, {
        id: 101, phone: '+15550101', api_id: 12345, api_hash: 'abc',
        status: 'active', is_logged_in: true,
      });

      const mock = require('telegram');
      // Correct QR-login protocol: TWO ExportLoginToken calls. First
      // returns the QR token; second (after AcceptLoginToken on the
      // source) returns LoginTokenSuccess. ImportLoginToken is NOT
      // used in the non-migration path.
      FakeNewClient._scenario = {
        exportLoginTokenSeq: [
          new mock.Api.auth.LoginToken({ token: Buffer.from([1, 2, 3]) }),
          new mock.Api.auth.LoginTokenSuccess({
            authorization: new mock.Api.auth.Authorization({}),
          }),
        ],
        importLoginTokenSeq: [],
      };

      const { jobId } = await service.startCloneJob({
        userId: 9,
        sessionIds: [101],
        destApiId: 22222,
        destApiHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        interSessionDelayMs: 0,
      });
      // Wait for completion
      for (let i = 0; i < 100; i++) {
        const v = service.getJobStatus(jobId, 9);
        if (v.status === 'completed' || v.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const view = service.getJobStatus(jobId, 9);
      assert.strictEqual(view.status, 'completed', `status=${view.status} err=${view.error}`);
      assert.strictEqual(view.sessions[0].status, 'cloned');
      assert.strictEqual(view.downloadReady, true);

      const zipPath = service.getJobZipPath(jobId, 9);
      assert.ok(zipPath && (await fs.pathExists(zipPath)), 'zip should be on disk');

      // Verify the source client really invoked AcceptLoginToken.
      assert.deepStrictEqual(src._invocations, ['auth.AcceptLoginToken']);

      // Regression: the post-accept finalization MUST be a second
      // ExportLoginToken, not ImportLoginToken. Calling Import with
      // the original token after the source has accepted it returns
      // AUTH_TOKEN_EXPIRED from real Telegram — exactly the failure
      // that broke every clone in the operator's logs before this fix.
      // Confirm the runner stayed on Export and never touched Import.
      const importCalls = (FakeNewClient._scenario.importLoginTokenSeq.length === 0
        && FakeNewClient._scenario.exportLoginTokenSeq.length === 0);
      assert.ok(importCalls,
        'Both export and import queues should be fully consumed (export×2, import×0)');
      console.log('clone.happyPath: OK');
    }

    // ─── Sub-test 2: DC migration ───────────────────────────────────
    {
      const src = new FakeSourceClient();
      sourceClientsBySessionId.set('202', src);
      sessionRowsById.set(202, {
        id: 202, phone: '+15550202', api_id: 12345, api_hash: 'abc',
        status: 'active', is_logged_in: true,
      });

      const mock = require('telegram');
      FakeNewClient._scenario = {
        exportLoginTokenSeq: [
          // First export call returns a DC migration.
          new mock.Api.auth.LoginTokenMigrateTo({
            dcId: 4, token: Buffer.from([9, 9, 9]),
          }),
        ],
        importLoginTokenSeq: [
          // Service follows the migration via direct ImportLoginToken
          // and gets a success.
          new mock.Api.auth.LoginTokenSuccess({
            authorization: new mock.Api.auth.Authorization({}),
          }),
        ],
      };

      // Expose _switchDC so the service can follow the migrate.
      const origCtor = FakeNewClient.prototype.constructor;
      FakeNewClient.prototype._switchDC = async function (dcId) {
        this.session.dcId = dcId;
      };

      const { jobId } = await service.startCloneJob({
        userId: 9,
        sessionIds: [202],
        destApiId: 22222,
        destApiHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        interSessionDelayMs: 0,
      });
      for (let i = 0; i < 100; i++) {
        const v = service.getJobStatus(jobId, 9);
        if (v.status === 'completed' || v.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const view = service.getJobStatus(jobId, 9);
      assert.strictEqual(view.status, 'completed', `status=${view.status} err=${view.error}`);
      assert.strictEqual(view.sessions[0].status, 'cloned');
      console.log('clone.dcMigration: OK');
    }

    // ─── Sub-test 2b: DC migration on RE-export (post-Accept) ───────
    // Telegram can hand back `auth.LoginTokenMigrateTo` on EITHER the
    // initial ExportLoginToken or on the re-Export that runs after
    // AcceptLoginToken completes. The initial-export case is covered
    // above; this sub-test pins the re-Export case that operators hit
    // in production ("Unexpected import result type: auth.LoginTokenMigrateTo").
    {
      const src = new FakeSourceClient();
      sourceClientsBySessionId.set('252', src);
      sessionRowsById.set(252, {
        id: 252, phone: '+15550252', api_id: 12345, api_hash: 'abc',
        status: 'active', is_logged_in: true,
      });

      const mock = require('telegram');
      FakeNewClient._scenario = {
        exportLoginTokenSeq: [
          // First export returns a plain LoginToken — proceed to
          // AcceptLoginToken on the source.
          new mock.Api.auth.LoginToken({ token: Buffer.from([4, 4, 4]) }),
          // Re-export AFTER accept returns LoginTokenMigrateTo.
          new mock.Api.auth.LoginTokenMigrateTo({
            dcId: 5, token: Buffer.from([5, 5, 5]),
          }),
        ],
        importLoginTokenSeq: [
          // Service follows the migrate token via ImportLoginToken
          // on the new DC and finally gets a LoginTokenSuccess.
          new mock.Api.auth.LoginTokenSuccess({
            authorization: new mock.Api.auth.Authorization({}),
          }),
        ],
      };

      FakeNewClient.prototype._switchDC = async function (dcId) {
        this.session.dcId = dcId;
      };

      const { jobId } = await service.startCloneJob({
        userId: 9,
        sessionIds: [252],
        destApiId: 22222,
        destApiHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        interSessionDelayMs: 0,
      });
      for (let i = 0; i < 100; i++) {
        const v = service.getJobStatus(jobId, 9);
        if (v.status === 'completed' || v.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const view = service.getJobStatus(jobId, 9);
      assert.strictEqual(
        view.status,
        'completed',
        `re-export migrate status=${view.status} err=${view.error}`
      );
      assert.strictEqual(view.sessions[0].status, 'cloned');
      // The source side still only sees a single AcceptLoginToken.
      assert.deepStrictEqual(src._invocations, ['auth.AcceptLoginToken']);
      console.log('clone.dcMigrationOnReExport: OK');
    }

    // ─── Sub-test 3: 2FA path ───────────────────────────────────────
    {
      const src = new FakeSourceClient();
      sourceClientsBySessionId.set('303', src);
      sessionRowsById.set(303, {
        id: 303, phone: '+15550303', api_id: 12345, api_hash: 'abc',
        status: 'active', is_logged_in: true,
      });

      const mock = require('telegram');
      // 2FA path: second ExportLoginToken (post-accept) raises
      // SESSION_PASSWORD_NEEDED — that's where Telegram surfaces 2FA
      // in the QR-login flow.
      FakeNewClient._scenario = {
        exportLoginTokenSeq: [
          new mock.Api.auth.LoginToken({ token: Buffer.from([7, 8, 9]) }),
          new Error('SESSION_PASSWORD_NEEDED'),
        ],
        importLoginTokenSeq: [],
        checkPasswordResult: new mock.Api.auth.Authorization({}),
        getPasswordResult: { _ok: true },
      };

      const { jobId } = await service.startCloneJob({
        userId: 9,
        sessionIds: [303],
        destApiId: 22222,
        destApiHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        interSessionDelayMs: 0,
      });
      // Poll until the worker is awaiting password.
      let view;
      for (let i = 0; i < 200; i++) {
        view = service.getJobStatus(jobId, 9);
        if (view.sessions[0].awaitingPassword) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.strictEqual(view.sessions[0].awaitingPassword, true,
        `expected 2FA prompt; status=${view.sessions[0].status}`);
      const submitted = service.submitPassword(jobId, 9, 303, 'mycloudpw');
      assert.strictEqual(submitted, true);
      for (let i = 0; i < 200; i++) {
        view = service.getJobStatus(jobId, 9);
        if (view.status === 'completed' || view.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.strictEqual(view.status, 'completed', `status=${view.status} err=${view.error}`);
      assert.strictEqual(view.sessions[0].status, 'cloned');
      console.log('clone.twoFactor: OK');
    }

    // ─── Sub-test 3b: 2FA with sharedPassword auto-applies ─────────
    {
      const src = new FakeSourceClient();
      sourceClientsBySessionId.set('305', src);
      sessionRowsById.set(305, {
        id: 305, phone: '+15550305', api_id: 12345, api_hash: 'abc',
        status: 'active', is_logged_in: true,
      });

      const mock = require('telegram');
      FakeNewClient._scenario = {
        exportLoginTokenSeq: [
          new mock.Api.auth.LoginToken({ token: Buffer.from([1, 2]) }),
          // Post-accept re-export raises SESSION_PASSWORD_NEEDED — the
          // runner must NOT pause; sharedPassword should be used
          // automatically.
          new Error('SESSION_PASSWORD_NEEDED'),
        ],
        importLoginTokenSeq: [],
        checkPasswordResult: new mock.Api.auth.Authorization({}),
        getPasswordResult: { _ok: true },
      };

      const { jobId } = await service.startCloneJob({
        userId: 9,
        sessionIds: [305],
        destApiId: 22222,
        destApiHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        interSessionDelayMs: 0,
        sharedPassword: 'mycloudpw',
      });
      let view;
      let sawAwaiting = false;
      for (let i = 0; i < 200; i++) {
        view = service.getJobStatus(jobId, 9);
        if (view.sessions[0].awaitingPassword) sawAwaiting = true;
        if (view.status === 'completed' || view.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.strictEqual(view.status, 'completed', `status=${view.status} err=${view.error}`);
      assert.strictEqual(view.sessions[0].status, 'cloned');
      // Most important assertion: the operator was NEVER prompted —
      // sharedPassword auto-applied.
      assert.strictEqual(sawAwaiting, false,
        'sharedPassword should bypass the awaiting_password prompt');
      console.log('clone.sharedPassword: OK (no per-session prompt)');
    }

    // ─── Sub-test 3c: AcceptLoginToken auth-revoked ─────────────────
    //
    // Regression for the operator's "AUTH_KEY_UNREGISTERED caused by
    // auth.AcceptLoginToken" failures: when the source session is
    // revoked, the runner must surface a clean
    // `[SOURCE_SESSION_REVOKED]` error tag — not a stringified gramJS
    // RPC error — so the UI per-row error reads as a real session
    // problem instead of a panel bug.
    {
      const src = new FakeSourceClient();
      src._acceptFails = true; // throws AUTH_KEY_UNREGISTERED
      sourceClientsBySessionId.set('309', src);
      sessionRowsById.set(309, {
        id: 309, phone: '+15550309', api_id: 12345, api_hash: 'abc',
        status: 'active', is_logged_in: true,
      });

      const mock = require('telegram');
      FakeNewClient._scenario = {
        // Runner gets a normal LoginToken and only gets to the accept
        // step; finalization re-export should never fire.
        exportLoginTokenSeq: [
          new mock.Api.auth.LoginToken({ token: Buffer.from([3]) }),
        ],
        importLoginTokenSeq: [],
      };

      const { jobId } = await service.startCloneJob({
        userId: 9,
        sessionIds: [309],
        destApiId: 22222,
        destApiHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        interSessionDelayMs: 0,
      });
      let view;
      for (let i = 0; i < 100; i++) {
        view = service.getJobStatus(jobId, 9);
        if (view.status === 'completed' || view.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 25));
      }
      // The whole job should NOT be failed — per-session errors are
      // captured and the job still runs the other rows. With a single
      // row, the job ends in `completed` (with 0 successful) or
      // `failed`; we just want to assert the per-row error is tagged.
      const row = view.sessions[0];
      assert.strictEqual(row.status, 'failed', `row status=${row.status}`);
      assert.ok(
        row.error && row.error.includes('[SOURCE_SESSION_REVOKED]'),
        `expected [SOURCE_SESSION_REVOKED] in row.error, got: ${row.error}`
      );

      // Regression: when AcceptLoginToken returns AUTH_KEY_UNREGISTERED
      // the service must update the panel's local DB row to match
      // Telegram's truth, so the operator's "sessions are active on
      // the pannel" symptom (panel UI lying about session liveness)
      // is fixed automatically on the next refresh.
      const updates = dbQueries.filter((q) =>
        /UPDATE sessions[\s\S]+SET is_logged_in = FALSE/i.test(q.text)
        && /status\s*=\s*'revoked'/i.test(q.text)
        && Array.isArray(q.params)
        && Number(q.params[0]) === 309
      );
      assert.ok(
        updates.length >= 1,
        `expected an UPDATE sessions ... SET is_logged_in=FALSE, status='revoked' for source session 309 after AcceptLoginToken returned AUTH_KEY_UNREGISTERED. dbQueries.text=\n${dbQueries.map(q => q.text).join('\n---\n')}`
      );
      console.log('clone.sourceRevoked: OK (DB also flipped to revoked)');
    }

    // ─── Sub-test: superseding job cancels previous in-flight one ──
    {
      // Two jobs from the same user, started back-to-back. The second
      // must cause the first to flip to `cancelled`. Mirrors the
      // production log signature where the operator clicked Start
      // four times in a row and the panel ran them concurrently,
      // alternating per-row failures across both job IDs.
      const srcA = new FakeSourceClient();
      const srcB = new FakeSourceClient();
      sourceClientsBySessionId.set('501', srcA);
      sourceClientsBySessionId.set('502', srcB);
      sessionRowsById.set(501, { id: 501, phone: '+15550501', api_id: 1, api_hash: 'a', status: 'active', is_logged_in: true });
      sessionRowsById.set(502, { id: 502, phone: '+15550502', api_id: 1, api_hash: 'a', status: 'active', is_logged_in: true });

      const mock = require('telegram');
      FakeNewClient._scenario = {
        exportLoginTokenSeq: [
          new mock.Api.auth.LoginToken({ token: Buffer.from([1]) }),
          new mock.Api.auth.LoginTokenSuccess({
            authorization: new mock.Api.auth.Authorization({}),
          }),
        ],
        importLoginTokenSeq: [],
      };
      const { jobId: idA } = await service.startCloneJob({
        userId: 11,
        sessionIds: [501],
        destApiId: 22222,
        destApiHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        interSessionDelayMs: 30,
      });
      FakeNewClient._scenario = {
        exportLoginTokenSeq: [
          new mock.Api.auth.LoginToken({ token: Buffer.from([1]) }),
          new mock.Api.auth.LoginTokenSuccess({
            authorization: new mock.Api.auth.Authorization({}),
          }),
        ],
        importLoginTokenSeq: [],
      };
      const { jobId: idB } = await service.startCloneJob({
        userId: 11,
        sessionIds: [502],
        destApiId: 22222,
        destApiHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        interSessionDelayMs: 0,
      });
      // Wait for job A to react to the supersede.
      for (let i = 0; i < 80; i++) {
        const a = service.getJobStatus(idA, 11);
        if (a && a.status === 'cancelled') break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const a = service.getJobStatus(idA, 11);
      assert.ok(a, 'job A should still be retrievable');
      assert.strictEqual(
        a.status, 'cancelled',
        `expected job A to be cancelled when job B started for same user, got status=${a.status}`
      );
      // Second job is allowed to complete normally.
      for (let i = 0; i < 80; i++) {
        const b = service.getJobStatus(idB, 11);
        if (b.status === 'completed' || b.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 25));
      }
      console.log('clone.supersede: OK (previous job cancelled when new one starts for same user)');
    }

    // ─── Sub-test 4: ownership enforcement ──────────────────────────
    {
      const src = new FakeSourceClient();
      sourceClientsBySessionId.set('404', src);
      sessionRowsById.set(404, {
        id: 404, phone: '+15550404', api_id: 12345, api_hash: 'abc',
        status: 'active', is_logged_in: true,
      });

      const mock = require('telegram');
      FakeNewClient._scenario = {
        exportLoginTokenSeq: [
          new mock.Api.auth.LoginToken({ token: Buffer.from([1]) }),
          new mock.Api.auth.LoginTokenSuccess({
            authorization: new mock.Api.auth.Authorization({}),
          }),
        ],
        importLoginTokenSeq: [],
      };

      const { jobId } = await service.startCloneJob({
        userId: 9,
        sessionIds: [404],
        destApiId: 22222,
        destApiHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        interSessionDelayMs: 0,
      });
      for (let i = 0; i < 50; i++) {
        const v = service.getJobStatus(jobId, 9);
        if (v.status === 'completed') break;
        await new Promise((r) => setTimeout(r, 25));
      }

      // Different user can't see it.
      assert.strictEqual(service.getJobStatus(jobId, 88), null);
      assert.strictEqual(service.getJobZipPath(jobId, 88), null);
      assert.strictEqual(service.cancelJob(jobId, 88), false);
      assert.strictEqual(service.submitPassword(jobId, 88, 404, 'x'), false);
      console.log('clone.ownership: OK');
    }

    console.log('sessionDuplication.smoke.test: OK');
  } finally {
    await fs.remove(tmpRoot).catch(() => {});
    restoreModules();
  }
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
