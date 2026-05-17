/* eslint-env node */
/* eslint-disable global-require */
'use strict';

/**
 * Bulk auth-purge — smoke test.
 *
 * Exercises sessionBulkAuthPurgeService end-to-end with mocked
 * telegramClientService and a mocked pool.query for the phone
 * lookup. No real Postgres or Telegram credentials required.
 *
 * Run with:
 *   node backend/test/sessions/bulkAuthPurge.smoke.test.js
 *
 * Verifies:
 *   T1   Job created, returns jobId immediately.
 *   T2   listAuthorizations called once per panel session.
 *   T3   resetAuthorization called for every non-current hash.
 *   T4   resetAuthorization NEVER called for the current panel hash.
 *   T5   Per-session status = 'completed' when every non-current
 *        device terminates cleanly.
 *   T6   Per-session status = 'partial' when one device fails and
 *        others succeed (error string surfaced on the row).
 *   T7   FRESH_RESET_FORBIDDEN device is reported as 'skipped'
 *        (not 'failed'); the parent session can still be 'completed'.
 *   T8   listAuthorizations failure marks the WHOLE row failed but
 *        the runner moves on to the next session.
 *   T9   'no_others' is reported when the account has only the
 *        current authorization (single device).
 *   T10  cancelJob() during a long inter-device delay stops the
 *        runner; subsequent rows are marked 'cancelled'.
 *   T11  publicJobView summary counts roll up correctly.
 *   T12  getJobStatus enforces ownership (wrong user → null).
 */

const path = require('path');
const assert = require('assert');

process.chdir(path.join(__dirname, '..', '..'));

// Override the DB pool's query() to a no-op before the service is
// required. The service uses pool.query only for the phone-label
// refresh — failing it is non-fatal so we just return an empty row.
const dbModule = require('../../src/config/database');
const fakePhoneByPanelId = new Map();
dbModule.pool.query = async (_sql, params) => {
  // Match the WHERE id = ANY($2::int[]) start-of-job lookup.
  if (Array.isArray(params) && Array.isArray(params[1])) {
    const ids = params[1];
    return {
      rows: ids.map((id) => ({
        id: Number(id),
        phone: fakePhoneByPanelId.get(Number(id)) || null,
      })),
    };
  }
  // Match the per-row WHERE id = $1 refresh. Return a synthetic row
  // so the runner doesn't mistakenly mark the session "not found".
  if (Array.isArray(params) && params.length >= 1) {
    const id = Number(params[0]);
    return {
      rows: [{ id, phone: fakePhoneByPanelId.get(id) || null }],
    };
  }
  return { rows: [] };
};

// Mock telegramClientService BEFORE requiring the bulk-auth-purge
// service. The service captures the require() reference at load time.
const tcs = require('../../src/services/telegramClientService');
const calls = { list: [], reset: [] };
let listImpl = async () => ({ authorizations: [] });
let resetImpl = async () => {};
tcs.listAuthorizations = async (sessionId, userId) => {
  calls.list.push({ sessionId, userId });
  return listImpl(sessionId, userId);
};
tcs.resetAuthorization = async (sessionId, userId, hash) => {
  calls.reset.push({ sessionId, userId, hash });
  return resetImpl(sessionId, userId, hash);
};

const service = require('../../src/services/sessionBulkAuthPurgeService');

let failures = 0;
function ok(name) { console.log(`  PASS  ${name}`); }
function fail(name, err) {
  failures += 1;
  console.error(`  FAIL  ${name}`);
  console.error(err && err.stack ? err.stack : err);
}

function reset() {
  calls.list.length = 0;
  calls.reset.length = 0;
  listImpl = async () => ({ authorizations: [] });
  resetImpl = async () => {};
}

function waitForTerminal(jobId, userId, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const view = service.getJobStatus(jobId, userId);
      if (view && (view.status === 'completed' || view.status === 'failed' || view.status === 'cancelled')) {
        clearInterval(iv);
        resolve(view);
        return;
      }
      if (Date.now() - t0 > timeoutMs) {
        clearInterval(iv);
        reject(new Error(`Timeout waiting for terminal status (last=${view && view.status})`));
      }
    }, 50);
  });
}

async function run(name, fn) {
  reset();
  try {
    await fn();
    ok(name);
  } catch (e) {
    fail(name, e);
  }
}

(async () => {
  const userId = 7;

  await run('T1+T2+T3+T4+T5  three sessions, mixed devices, current preserved', async () => {
    fakePhoneByPanelId.set(101, '+11111111111');
    fakePhoneByPanelId.set(102, '+22222222222');
    fakePhoneByPanelId.set(103, '+33333333333');

    listImpl = async (sessionId) => {
      if (sessionId == 101) {
        return {
          authorizations: [
            { hash: 'h101_current', isCurrent: true, deviceModel: 'panel' },
            { hash: 'h101_phone',   isCurrent: false, deviceModel: 'iPhone',    country: 'IN' },
            { hash: 'h101_desktop', isCurrent: false, deviceModel: 'Mac',       country: 'US' },
          ],
        };
      }
      if (sessionId == 102) {
        return {
          authorizations: [
            { hash: 'h102_current', isCurrent: true,  deviceModel: 'panel' },
            { hash: 'h102_web',     isCurrent: false, deviceModel: 'web' },
          ],
        };
      }
      return {
        authorizations: [
          { hash: 'h103_current', isCurrent: true, deviceModel: 'panel' },
        ],
      };
    };
    resetImpl = async () => { /* all succeed */ };

    const { jobId } = await service.startBulkAuthPurgeJob({
      userId,
      sessionIds: [101, 102, 103],
      interSessionDelayMs: 5,
      interDeviceDelayMs: 5,
    });
    assert(typeof jobId === 'string' && jobId.startsWith('bulk-auth-purge-'), 'T1 jobId shape');

    const view = await waitForTerminal(jobId, userId);
    assert.strictEqual(view.status, 'completed', 'T1 job completed');

    // T2: listAuthorizations called once per panel session.
    assert.strictEqual(calls.list.length, 3, 'T2 list called once per session');
    // T3 + T4: resetAuthorization called for every non-current hash
    // and NEVER for the current panel hash.
    const resetHashes = calls.reset.map((c) => c.hash).sort();
    assert.deepStrictEqual(
      resetHashes,
      ['h101_desktop', 'h101_phone', 'h102_web'].sort(),
      'T3/T4 only non-current hashes terminated'
    );
    assert(
      !resetHashes.includes('h101_current') &&
      !resetHashes.includes('h102_current') &&
      !resetHashes.includes('h103_current'),
      'T4 panel current authorizations preserved'
    );

    // T5: per-session statuses.
    const byId = new Map(view.sessions.map((s) => [s.sessionId, s]));
    assert.strictEqual(byId.get(101).status, 'completed', 'T5 session 101 completed');
    assert.strictEqual(byId.get(102).status, 'completed', 'T5 session 102 completed');
    assert.strictEqual(byId.get(103).status, 'no_others', 'T9 session 103 no_others');

    // Sub-row: current device is reported as kept.
    const dev101 = byId.get(101).devices.find((d) => d.hash === 'h101_current');
    assert.strictEqual(dev101.status, 'kept', 'T4 current device marked kept');
    assert.strictEqual(dev101.isCurrent, true, 'T4 current flag preserved');

    // T11: summary roll-up.
    assert.strictEqual(view.summary.completed, 2, 'T11 summary.completed');
    assert.strictEqual(view.summary.noOthers, 1, 'T11 summary.noOthers');
    assert.strictEqual(view.summary.devicesTerminated, 3, 'T11 devicesTerminated');
    assert.strictEqual(view.summary.devicesFailed, 0, 'T11 devicesFailed');
  });

  await run('T6  partial — one device fails, others succeed', async () => {
    fakePhoneByPanelId.set(201, '+44444444444');
    listImpl = async () => ({
      authorizations: [
        { hash: 'cur', isCurrent: true,  deviceModel: 'panel' },
        { hash: 'ok1', isCurrent: false, deviceModel: 'iPhone' },
        { hash: 'bad', isCurrent: false, deviceModel: 'tampered' },
        { hash: 'ok2', isCurrent: false, deviceModel: 'web' },
      ],
    });
    resetImpl = async (_sid, _uid, hash) => {
      if (hash === 'bad') {
        const e = new Error('AUTH_KEY_UNREGISTERED');
        e.code = 'RESET_AUTH_FAILED';
        throw e;
      }
    };

    const { jobId } = await service.startBulkAuthPurgeJob({
      userId, sessionIds: [201], interDeviceDelayMs: 1,
    });
    const view = await waitForTerminal(jobId, userId);
    const s = view.sessions[0];
    assert.strictEqual(s.status, 'partial', 'T6 row status partial');
    assert(/1 of 3 device/i.test(s.error || ''), 'T6 error surfaces ratio');
    const byHash = new Map(s.devices.map((d) => [d.hash, d]));
    assert.strictEqual(byHash.get('ok1').status, 'terminated', 'T6 ok1 terminated');
    assert.strictEqual(byHash.get('bad').status, 'failed', 'T6 bad failed');
    assert(/AUTH_KEY_UNREGISTERED/.test(byHash.get('bad').error || ''), 'T6 device error surfaced');
    assert.strictEqual(byHash.get('ok2').status, 'terminated', 'T6 ok2 terminated');
    assert.strictEqual(view.summary.partial, 1, 'T11 summary.partial');
    assert.strictEqual(view.summary.devicesTerminated, 2, 'T11 devicesTerminated counted');
    assert.strictEqual(view.summary.devicesFailed, 1, 'T11 devicesFailed counted');
  });

  await run('T7  FRESH_RESET_FORBIDDEN → skipped, row still completes', async () => {
    listImpl = async () => ({
      authorizations: [
        { hash: 'cur', isCurrent: true,  deviceModel: 'panel' },
        { hash: 'old', isCurrent: false, deviceModel: 'old-iPhone' },
        { hash: 'fresh', isCurrent: false, deviceModel: 'new-iPhone' },
      ],
    });
    resetImpl = async (_sid, _uid, hash) => {
      if (hash === 'fresh') {
        const e = new Error('FRESH_RESET_AUTHORISATION_FORBIDDEN');
        // The real telegramClientService raises AppError with this code:
        e.code = 'FRESH_RESET_FORBIDDEN';
        throw e;
      }
    };

    const { jobId } = await service.startBulkAuthPurgeJob({
      userId, sessionIds: [301], interDeviceDelayMs: 1,
    });
    const view = await waitForTerminal(jobId, userId);
    const s = view.sessions[0];
    assert.strictEqual(s.status, 'completed', 'T7 row completed despite skip');
    const byHash = new Map(s.devices.map((d) => [d.hash, d]));
    assert.strictEqual(byHash.get('fresh').status, 'skipped', 'T7 fresh device skipped');
    assert(/24h/i.test(byHash.get('fresh').error || ''), 'T7 skip reason mentions 24h');
    assert.strictEqual(view.summary.devicesSkipped, 1, 'T11 devicesSkipped counted');
  });

  await run('T8  listAuthorizations fails → that row failed, next row continues', async () => {
    let i = 0;
    listImpl = async (sid) => {
      i += 1;
      if (sid == 401) throw new Error('NETWORK_DOWN');
      return {
        authorizations: [
          { hash: 'cur', isCurrent: true, deviceModel: 'panel' },
          { hash: 'kill1', isCurrent: false, deviceModel: 'iPhone' },
        ],
      };
    };
    resetImpl = async () => {};

    const { jobId } = await service.startBulkAuthPurgeJob({
      userId, sessionIds: [401, 402], interSessionDelayMs: 1, interDeviceDelayMs: 1,
    });
    const view = await waitForTerminal(jobId, userId);
    assert.strictEqual(view.status, 'completed', 'T8 outer job still completed');
    const byId = new Map(view.sessions.map((s) => [s.sessionId, s]));
    assert.strictEqual(byId.get(401).status, 'failed', 'T8 401 marked failed');
    assert(/listAuthorizations/i.test(byId.get(401).error || ''), 'T8 401 error surfaced');
    assert.strictEqual(byId.get(402).status, 'completed', 'T8 402 still ran');
    assert(i >= 2, 'T8 both listAuthorizations attempted');
  });

  await run('T10  cancelJob mid-flight stops subsequent rows', async () => {
    fakePhoneByPanelId.set(501, '+5');
    fakePhoneByPanelId.set(502, '+5');
    fakePhoneByPanelId.set(503, '+5');

    let firstResetSeen = null;
    listImpl = async (sid) => ({
      authorizations: [
        { hash: `cur_${sid}`, isCurrent: true,  deviceModel: 'panel' },
        { hash: `t1_${sid}`,  isCurrent: false, deviceModel: 'iPhone' },
        { hash: `t2_${sid}`,  isCurrent: false, deviceModel: 'web' },
      ],
    });
    resetImpl = async (sid, _u, hash) => {
      if (!firstResetSeen) firstResetSeen = { sid, hash };
      // Slow each reset so we have time to cancel between rows.
      await new Promise((r) => setTimeout(r, 60));
    };

    const { jobId } = await service.startBulkAuthPurgeJob({
      userId, sessionIds: [501, 502, 503],
      interSessionDelayMs: 30, interDeviceDelayMs: 30,
    });

    // Cancel after first row's first reset is observed.
    await new Promise((r) => setTimeout(r, 80));
    const okFlag = service.cancelJob(jobId, userId);
    assert.strictEqual(okFlag, true, 'T10 cancelJob returned true');

    const view = await waitForTerminal(jobId, userId, 15_000);
    assert.strictEqual(view.status, 'cancelled', 'T10 outer job cancelled');
    const byId = new Map(view.sessions.map((s) => [s.sessionId, s]));
    // Row 503 should never have run.
    assert(
      byId.get(503).status === 'cancelled' || byId.get(503).status === 'queued',
      `T10 503 not executed (status=${byId.get(503).status})`
    );
  });

  await run('T12  getJobStatus ownership check', async () => {
    listImpl = async () => ({
      authorizations: [{ hash: 'cur', isCurrent: true, deviceModel: 'panel' }],
    });
    const { jobId } = await service.startBulkAuthPurgeJob({
      userId: 9, sessionIds: [601],
    });
    await waitForTerminal(jobId, 9);
    const wrong = service.getJobStatus(jobId, 8);
    assert.strictEqual(wrong, null, 'T12 wrong user gets null');
    const right = service.getJobStatus(jobId, 9);
    assert(right && right.jobId === jobId, 'T12 owner gets view');
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) FAILED`);
    process.exit(1);
  } else {
    console.log('\nAll bulk-auth-purge smoke tests passed.');
    process.exit(0);
  }
})().catch((e) => {
  console.error('Unhandled error in smoke test', e);
  process.exit(2);
});
