/**
 * Smoke test for the per-session photo-queue apply path.
 *
 * Locks in:
 *   1. Validation rejects empty queue, missing photoPath, paths outside
 *      the uploads dir, paths that don't exist on disk, and assignments
 *      with no sessions.
 *   2. Ownership filtering: sessions not owned by the caller are
 *      reported as failures and do not call telegramService.
 *   3. Batch isolation: a single session's failure (e.g. revoked auth)
 *      does NOT abort the rest of the queue.
 *   4. Each (assignmentIndex, sessionId) pair gets its own result row
 *      and the totals reflect the per-session counts.
 *   5. Multiple assignments with the same session apply in order
 *      (last-write-wins is up to Telegram; we just verify the RPCs
 *      fire in submission order).
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Stub the telegram service BEFORE the account-settings service is
// loaded so the service binds to our stub at require time.
const telegramService = require('../../src/services/telegramService');
const updateProfilePhotoCalls = [];
telegramService.updateProfilePhoto = async (sid, photoPath) => {
  updateProfilePhotoCalls.push({ sid, photoPath });
  // Simulate a single failing session to exercise batch isolation.
  if (String(sid) === '777') {
    const err = new Error('AUTH_KEY_UNREGISTERED');
    err.errorCode = 'AUTH_KEY_UNREGISTERED';
    throw err;
  }
  return { success: true };
};

// Stub the DB so the service's ownership check has predictable rows.
const dbPath = require.resolve('../../src/config/database');
delete require.cache[dbPath];
const db = require(dbPath);
db.pool = {
  query: async (sql, params) => {
    if (/FROM sessions WHERE id = ANY/i.test(sql)) {
      const ids = params[0];
      // 111, 222, 777 are owned. 999 is not.
      return {
        rows: ids
          .filter((id) => [111, 222, 777].includes(Number(id)))
          .map((id) => ({
            id: Number(id),
            phone: `+1-555-${String(id).padStart(4, '0')}`,
            status: 'active',
          })),
      };
    }
    if (/INSERT INTO activity_logs/i.test(sql)) return { rows: [] };
    throw new Error('unexpected query: ' + sql);
  },
};

const servicePath = require.resolve(
  '../../src/services/accountSettingsService'
);
delete require.cache[servicePath];
const svc = require(servicePath);

// Helper: write a real file under the uploads dir so the path-validation
// check passes.
function makeUploadFile(name = 'test.jpg') {
  const uploadDir = path.join(os.tmpdir(), 'telegram-panel', 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  const filePath = path.join(uploadDir, `smoke_${Date.now()}_${name}`);
  fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic
  return filePath;
}

async function assertRejects(promise, codeRegex, msg) {
  let thrown;
  try {
    await promise;
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, `${msg}: expected rejection but resolved`);
  assert.ok(
    codeRegex.test(thrown.errorCode || thrown.code || thrown.message),
    `${msg}: code "${thrown.errorCode || thrown.code || thrown.message}" did not match ${codeRegex}`
  );
}

async function testValidation() {
  // Missing userId
  await assertRejects(
    svc.applyPhotoAssignments({ assignments: [] }, null),
    /MISSING_USER_ID/,
    'no userId'
  );
  // Empty queue
  await assertRejects(
    svc.applyPhotoAssignments({ assignments: [] }, 1),
    /NO_ASSIGNMENTS/,
    'empty queue'
  );
  // Missing photoPath
  await assertRejects(
    svc.applyPhotoAssignments(
      { assignments: [{ photoPath: '', sessionIds: [111] }] },
      1
    ),
    /INVALID_ASSIGNMENT/,
    'empty photoPath'
  );
  // Path outside uploads dir
  await assertRejects(
    svc.applyPhotoAssignments(
      {
        assignments: [
          { photoPath: '/etc/passwd', sessionIds: [111] },
        ],
      },
      1
    ),
    /INVALID_PHOTO_PATH/,
    'path traversal blocked'
  );
  // Path that doesn't exist
  const fakePath = path.join(
    os.tmpdir(),
    'telegram-panel',
    'uploads',
    'does_not_exist.jpg'
  );
  await assertRejects(
    svc.applyPhotoAssignments(
      { assignments: [{ photoPath: fakePath, sessionIds: [111] }] },
      1
    ),
    /PHOTO_NOT_FOUND/,
    'missing file'
  );
  // No sessions in assignment
  const realPath = makeUploadFile('v1.jpg');
  await assertRejects(
    svc.applyPhotoAssignments(
      { assignments: [{ photoPath: realPath, sessionIds: [] }] },
      1
    ),
    /NO_SESSIONS_IN_ASSIGNMENT/,
    'empty sessionIds'
  );
  console.log('validation: OK');
}

async function testOwnershipAndBatchIsolation() {
  updateProfilePhotoCalls.length = 0;
  const photoA = makeUploadFile('a.jpg');
  const photoB = makeUploadFile('b.jpg');

  const result = await svc.applyPhotoAssignments(
    {
      assignments: [
        // Assignment 1: photoA → owned (111), revoked (777), not-owned (999)
        { photoPath: photoA, sessionIds: [111, 777, 999] },
        // Assignment 2: photoB → owned (222)
        { photoPath: photoB, sessionIds: [222] },
      ],
    },
    42 // userId
  );

  assert.strictEqual(result.totalAssignments, 2);
  // Total sessions counted = 3 + 1 = 4 (including the not-owned one)
  assert.strictEqual(result.totalSessions, 4);
  // 111 + 222 succeed. 777 fails (AUTH_KEY_UNREGISTERED). 999 fails (ownership).
  assert.strictEqual(result.success, 2, 'expected 2 successes');
  assert.strictEqual(result.failed, 2, 'expected 2 failures');

  // Per-row structure
  const r111 = result.results.find(
    (r) => r.sessionId === 111 && r.assignmentIndex === 0
  );
  assert.ok(r111 && r111.success, 'session 111 in assignment 0 should succeed');

  const r777 = result.results.find((r) => r.sessionId === 777);
  assert.ok(r777 && !r777.success, 'session 777 should fail');
  assert.ok(
    /AUTH_KEY_UNREGISTERED/.test((r777.errors || []).join(';')),
    'AUTH_KEY_UNREGISTERED must surface in errors'
  );

  const r999 = result.results.find((r) => r.sessionId === 999);
  assert.ok(r999 && !r999.success, 'session 999 (not owned) should fail');
  assert.ok(
    /not owned/i.test((r999.errors || []).join(';')),
    'ownership error must mention not-owned'
  );

  const r222 = result.results.find(
    (r) => r.sessionId === 222 && r.assignmentIndex === 1
  );
  assert.ok(r222 && r222.success, 'session 222 in assignment 1 should succeed');

  // 999 must NOT have been forwarded to telegramService (ownership check).
  const had999 = updateProfilePhotoCalls.some(
    (c) => String(c.sid) === '999'
  );
  assert.ok(
    !had999,
    'non-owned sessions must never be forwarded to telegramService'
  );

  console.log('ownership + batch isolation: OK');
}

async function testInOrderDispatch() {
  updateProfilePhotoCalls.length = 0;
  const p1 = makeUploadFile('1.jpg');
  const p2 = makeUploadFile('2.jpg');

  await svc.applyPhotoAssignments(
    {
      assignments: [
        { photoPath: p1, sessionIds: [111] },
        { photoPath: p2, sessionIds: [111] },
      ],
    },
    7
  );

  // Both RPCs must have fired in submission order. Telegram resolves
  // last-write-wins on its side; we just verify the panel didn't reorder.
  assert.strictEqual(
    updateProfilePhotoCalls.length,
    2,
    'expected 2 uploadProfilePhoto calls'
  );
  assert.strictEqual(updateProfilePhotoCalls[0].photoPath, p1);
  assert.strictEqual(updateProfilePhotoCalls[1].photoPath, p2);
  console.log('in-order dispatch: OK');
}

(async () => {
  await testValidation();
  await testOwnershipAndBatchIsolation();
  await testInOrderDispatch();
  console.log('\nAll photoQueueAssignments smoke checks passed.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
