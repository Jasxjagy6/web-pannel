/**
 * Smoke test for the "Remove all profile photos" bulk action.
 *
 * Locks in:
 *   1. telegramService.removeAllProfilePhotos invokes
 *      photos.GetUserPhotos and photos.DeletePhotos, returning the
 *      total number of photos wiped. (newPhotoId=null path of
 *      _deletePriorProfilePhotos.)
 *   2. The session-scoped wrapper returns { success:true,
 *      updatedField:'profile_photo', deletedCount:N } on success.
 *   3. accountSettingsService.removeAllProfilePhotos surfaces the
 *      shape the controller forwards to the frontend:
 *      { total, success, failed, totalDeleted, results:[...] }.
 *   4. Per-session failures are isolated — one session throwing does
 *      NOT abort the rest of the batch. This is the critical
 *      behaviour for 40-session bulk runs.
 *   5. The "no photos to delete" case reports success with
 *      deletedCount=0 instead of an error.
 */

'use strict';

const assert = require('assert');

const telegramService = require('../../src/services/telegramService');

// ──────────────────────────────────────────────────────────────────
// 1. telegramService.removeAllProfilePhotos — happy path
// ──────────────────────────────────────────────────────────────────
async function testTelegramServiceHappyPath() {
  const sid = '__removeAllHappyTest__';

  telegramService._ensureConnected = async () => {};
  telegramService._withFloodRetry = async (_s, fn) => fn();

  const calls = [];
  telegramService.clients = new Map([
    [
      sid,
      {
        client: {
          invoke: async (req) => {
            const cn = (req && req.className) || '';
            calls.push(cn);
            if (/GetUserPhotos/i.test(cn)) {
              return {
                photos: [
                  { className: 'Photo', id: BigInt(11), accessHash: BigInt(1), fileReference: Buffer.from([]) },
                  { className: 'Photo', id: BigInt(22), accessHash: BigInt(2), fileReference: Buffer.from([]) },
                  { className: 'Photo', id: BigInt(33), accessHash: BigInt(3), fileReference: Buffer.from([]) },
                ],
              };
            }
            if (/DeletePhotos/i.test(cn)) {
              // Telegram returns a list of deleted IDs (or empty list).
              return [];
            }
            throw new Error('unexpected invoke ' + cn);
          },
        },
      },
    ],
  ]);

  const result = await telegramService.removeAllProfilePhotos(sid);
  assert.strictEqual(result.success, true, 'expected success=true');
  assert.strictEqual(result.updatedField, 'profile_photo');
  assert.strictEqual(result.deletedCount, 3, 'expected all 3 photos deleted');

  // Sanity: both RPCs must have been invoked.
  assert.ok(
    calls.some((c) => /GetUserPhotos/i.test(c)),
    'expected photos.GetUserPhotos to be invoked'
  );
  assert.ok(
    calls.some((c) => /DeletePhotos/i.test(c)),
    'expected photos.DeletePhotos to be invoked'
  );
  console.log('telegramService.removeAllProfilePhotos.happyPath: OK');
}

// ──────────────────────────────────────────────────────────────────
// 2. telegramService.removeAllProfilePhotos — no photos to delete
// ──────────────────────────────────────────────────────────────────
async function testTelegramServiceNoPhotos() {
  const sid = '__removeAllEmptyTest__';

  telegramService._ensureConnected = async () => {};
  telegramService._withFloodRetry = async (_s, fn) => fn();

  let deletePhotosInvoked = false;
  telegramService.clients = new Map([
    [
      sid,
      {
        client: {
          invoke: async (req) => {
            const cn = (req && req.className) || '';
            if (/GetUserPhotos/i.test(cn)) return { photos: [] };
            if (/DeletePhotos/i.test(cn)) {
              deletePhotosInvoked = true;
              return [];
            }
            throw new Error('unexpected invoke ' + cn);
          },
        },
      },
    ],
  ]);

  const result = await telegramService.removeAllProfilePhotos(sid);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.deletedCount, 0, 'expected 0 when nothing to delete');
  assert.strictEqual(
    deletePhotosInvoked,
    false,
    'photos.DeletePhotos must NOT be called when there are no photos'
  );
  console.log('telegramService.removeAllProfilePhotos.noPhotos: OK');
}

// ──────────────────────────────────────────────────────────────────
// 3. accountSettingsService.removeAllProfilePhotos — batch shape
//    (per-session failure isolation, totals, activity_log entry).
// ──────────────────────────────────────────────────────────────────
async function testAccountSettingsServiceBatchIsolation() {
  // We mock the parts of the service that hit the DB / telegram so the
  // test stays self-contained. The service module re-uses the
  // telegramService singleton for the underlying RPC, so we stub at the
  // telegramService level + replace the pool object before requiring.
  const accountSettingsServicePath = require.resolve(
    '../../src/services/accountSettingsService'
  );

  // Wipe the cached service module so our pool stub takes effect.
  delete require.cache[accountSettingsServicePath];

  // Stub the database pool to avoid hitting Postgres.
  const dbPath = require.resolve('../../src/config/database');
  const realDb = require(dbPath);
  const fakePool = {
    query: async (sql, params) => {
      if (/FROM sessions WHERE id = ANY/i.test(sql)) {
        // Three sessions owned by the user.
        return {
          rows: [
            { id: 11, phone: '+1-555-0011', status: 'active' },
            { id: 22, phone: '+1-555-0022', status: 'active' },
            { id: 33, phone: '+1-555-0033', status: 'active' },
          ],
        };
      }
      if (/INSERT INTO activity_logs/i.test(sql)) {
        // Capture the activity-log payload for the assertion below.
        fakePool.lastActivityLog = { sql, params };
        return { rows: [] };
      }
      throw new Error('unexpected query ' + sql);
    },
  };
  realDb.pool = fakePool;

  // Re-require the service module so it picks up the mutated pool.
  const svc = require(accountSettingsServicePath);

  // Stub the telegram side: session 22 throws, the other two succeed.
  telegramService.removeAllProfilePhotos = async (sid) => {
    if (sid === '22') {
      throw new Error('AUTH_KEY_UNREGISTERED');
    }
    return {
      success: true,
      updatedField: 'profile_photo',
      deletedCount: sid === '11' ? 2 : 1,
    };
  };

  const result = await svc.removeAllProfilePhotos(
    { sessionIds: [11, 22, 33] },
    42 // userId
  );

  assert.strictEqual(result.total, 3, 'expected total=3');
  assert.strictEqual(result.success, 2, 'expected 2 successes');
  assert.strictEqual(result.failed, 1, 'expected 1 failure');
  assert.strictEqual(result.totalDeleted, 3, 'expected 2 + 0 + 1 = 3 deleted');
  assert.strictEqual(result.results.length, 3);

  // Per-session shape.
  const r11 = result.results.find((r) => r.sessionId === 11);
  const r22 = result.results.find((r) => r.sessionId === 22);
  const r33 = result.results.find((r) => r.sessionId === 33);
  assert.ok(r11 && r22 && r33, 'expected per-session rows for all three');
  assert.strictEqual(r11.success, true);
  assert.strictEqual(r11.deletedCount, 2);
  assert.strictEqual(r22.success, false);
  assert.ok(
    r22.errors.length > 0 && /AUTH_KEY_UNREGISTERED/.test(r22.errors[0]),
    `expected AUTH_KEY_UNREGISTERED error on session 22, got ${JSON.stringify(r22.errors)}`
  );
  assert.strictEqual(r33.success, true);
  assert.strictEqual(r33.deletedCount, 1);

  // Activity log was written with the correct counts.
  assert.ok(fakePool.lastActivityLog, 'expected activity_logs INSERT');
  const [, params] = [
    fakePool.lastActivityLog.sql,
    fakePool.lastActivityLog.params,
  ];
  assert.strictEqual(params[0], 42, 'expected user id in activity log');
  const details = JSON.parse(params[1]);
  assert.strictEqual(details.sessionCount, 3);
  assert.strictEqual(details.successCount, 2);
  assert.strictEqual(details.totalDeleted, 3);

  console.log('accountSettingsService.removeAllProfilePhotos.batchIsolation: OK');
}

// ──────────────────────────────────────────────────────────────────
// 4. accountSettingsService.removeAllProfilePhotos — input validation
// ──────────────────────────────────────────────────────────────────
async function testAccountSettingsServiceValidation() {
  const accountSettingsServicePath = require.resolve(
    '../../src/services/accountSettingsService'
  );
  const svc = require(accountSettingsServicePath);

  // Missing userId.
  let thrown;
  try {
    await svc.removeAllProfilePhotos({ sessionIds: [1] }, null);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'expected throw on missing userId');
  assert.strictEqual(thrown.errorCode, 'MISSING_USER_ID');

  // Empty sessionIds.
  thrown = undefined;
  try {
    await svc.removeAllProfilePhotos({ sessionIds: [] }, 1);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'expected throw on empty sessionIds');
  assert.strictEqual(thrown.errorCode, 'NO_SESSIONS');

  // All non-numeric sessionIds.
  thrown = undefined;
  try {
    await svc.removeAllProfilePhotos({ sessionIds: ['abc', null, -1] }, 1);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'expected throw on garbage sessionIds');
  assert.strictEqual(thrown.errorCode, 'NO_VALID_SESSIONS');

  console.log('accountSettingsService.removeAllProfilePhotos.validation: OK');
}

// Sequence the async test bodies so they don't race over the shared
// telegramService singleton / cached service module.
(async () => {
  await testTelegramServiceHappyPath();
  await testTelegramServiceNoPhotos();
  await testAccountSettingsServiceValidation();
  await testAccountSettingsServiceBatchIsolation();
  console.log('\nAll removeAllProfilePhotos smoke checks passed.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
