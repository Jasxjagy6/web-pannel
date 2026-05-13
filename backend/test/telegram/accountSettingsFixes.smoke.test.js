/**
 * Smoke test for the three Account-Settings bugs reported in
 * production logs (2026-05-13) and fixed in this PR:
 *
 *   1. USERNAME_NOT_MODIFIED — When a session's current username
 *      already equals the desired one (including when both are the
 *      empty string i.e. "clear an already-empty username"), Telegram
 *      throws `400: USERNAME_NOT_MODIFIED`. The panel used to surface
 *      that as a failure, which made bulk-randomize batches report
 *      false negatives for every no-op row. The fix treats it as a
 *      success because the end state matches what the caller asked
 *      for.
 *
 *   2. PHOTO_CROP_SIZE_SMALL — Telegram rejects profile photos with
 *      a smallest-side below ~160 px. The previous avatar seed pool
 *      shipped 200 portraits from randomuser.me, all 128×128, which
 *      hit this floor on every single upload. The new pool is sourced
 *      exclusively from Wikipedia pageimages of real actors; every
 *      bundled portrait must be ≥320 on the smaller side.
 *
 *   3. Old photo not removed / new one not promoted — `photos.UploadProfilePhoto`
 *      sets the new photo as the visible avatar but earlier photos
 *      stay in the profile-photo history, and on bought sessions
 *      whose seller already uploaded a photo, operators reported the
 *      old picture still being visible. The fix follows up with
 *      `photos.GetUserPhotos` + `photos.DeletePhotos` so the freshly
 *      uploaded photo is unambiguously the only photo on the account.
 */

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const telegramService = require('../../src/services/telegramService');
const randomAvatars = require('../../src/data/randomAvatars');

// ──────────────────────────────────────────────────────────────────
// 1. Avatar pool quality
// ──────────────────────────────────────────────────────────────────
const avatars = randomAvatars.getAvatars();
assert.ok(
  avatars.length >= 150,
  `expected 150+ bundled avatars, got ${avatars.length}`
);
// `image-size` is already a transitive dep so this is safe in tests too.
const sizeOf = require('image-size');
let smallest = Infinity;
for (const { absPath } of avatars) {
  const dims = sizeOf(absPath);
  const short = Math.min(dims.width, dims.height);
  if (short < smallest) smallest = short;
  // Telegram's documented floor is ~160. Require a safety margin of 320.
  assert.ok(
    short >= 320,
    `avatar ${path.basename(absPath)} short-side ${short}px is below 320 — would risk PHOTO_CROP_SIZE_SMALL`
  );
}
console.log(`avatarPool: OK (${avatars.length} portraits, smallest short side ${smallest}px)`);

// Sanity: there must be NO randomuser.me 128×128 portraits left in the pool.
const stillSmall = avatars.filter((a) => {
  try {
    const d = sizeOf(a.absPath);
    return Math.min(d.width, d.height) <= 128;
  } catch (_) {
    return false;
  }
});
assert.strictEqual(
  stillSmall.length,
  0,
  `expected zero 128x128 portraits in the pool, found ${stillSmall.length}`
);
console.log('avatarPool.noRandomuserResidue: OK');

// ──────────────────────────────────────────────────────────────────
// 2. updateUsername: USERNAME_NOT_MODIFIED → success
// ──────────────────────────────────────────────────────────────────
async function testUsernameNotModified() {
  const sid = '__usernameNotModifiedTest__';

  telegramService._ensureConnected = async () => {};
  telegramService._withFloodRetry = async (_s, fn) => fn();

  // (a) USERNAME_NOT_MODIFIED with non-empty username (already set)
  {
    let invokes = 0;
    telegramService.clients = new Map([
      [
        sid,
        {
          client: {
            invoke: async (req) => {
              invokes += 1;
              if (req && req.className && /UpdateUsername/i.test(req.className)) {
                throw new Error('400: USERNAME_NOT_MODIFIED (caused by account.UpdateUsername)');
              }
              // GetMe -> return a stub user; getMe() falls back through this
              throw new Error('unexpected invoke ' + (req && req.className));
            },
          },
        },
      ],
    ]);
    // getMe is only called on the success path; in this stubbed environment
    // it would also hit invoke. Replace it with a stub so the helper doesn't
    // crash when refreshing the profile.
    const originalGetMe = telegramService.getMe;
    telegramService.getMe = async () => ({ id: 1, username: 'alex' });
    try {
      const result = await telegramService.updateUsername(sid, 'alex');
      assert.strictEqual(result.unchanged, true, 'expected unchanged=true');
      assert.strictEqual(result.updatedField, 'username');
      assert.strictEqual(result.username, 'alex');
      assert.ok(invokes >= 1, 'expected at least one invoke');
    } finally {
      telegramService.getMe = originalGetMe;
    }
  }

  // (b) USERNAME_NOT_MODIFIED on the clear-username path (empty -> empty)
  {
    telegramService.clients = new Map([
      [
        sid,
        {
          client: {
            invoke: async (req) => {
              if (req && req.className && /UpdateUsername/i.test(req.className)) {
                assert.strictEqual(req.username, '', 'expected empty string on clear path');
                throw new Error('400: USERNAME_NOT_MODIFIED (caused by account.UpdateUsername)');
              }
              throw new Error('unexpected invoke');
            },
          },
        },
      ],
    ]);
    const originalGetMe = telegramService.getMe;
    telegramService.getMe = async () => ({ id: 1, username: '' });
    try {
      const result = await telegramService.updateUsername(sid, '');
      assert.strictEqual(result.unchanged, true);
      assert.strictEqual(result.username, '');
    } finally {
      telegramService.getMe = originalGetMe;
    }
  }

  // (c) An unrelated error (USERNAME_INVALID) must still bubble up as a throw.
  {
    telegramService.clients = new Map([
      [
        sid,
        {
          client: {
            invoke: async () => {
              throw new Error('400: USERNAME_INVALID (caused by account.UpdateUsername)');
            },
          },
        },
      ],
    ]);
    let thrown;
    try {
      await telegramService.updateUsername(sid, 'bogus#name');
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, 'expected USERNAME_INVALID to bubble up');
    // _handleTelegramError translates the raw RPC code into a human
    // message and stamps the AppError with .code='USERNAME_INVALID'.
    assert.ok(
      /USERNAME_INVALID/i.test(thrown.message) ||
        thrown.code === 'USERNAME_INVALID',
      `expected USERNAME_INVALID indicator (got message="${thrown.message}", code="${thrown.code}")`
    );
  }

  // (d) Leading @ is stripped before the call.
  {
    let seenUsername = null;
    telegramService.clients = new Map([
      [
        sid,
        {
          client: {
            invoke: async (req) => {
              if (req && req.className && /UpdateUsername/i.test(req.className)) {
                seenUsername = req.username;
                return { id: 1 };
              }
              throw new Error('unexpected');
            },
          },
        },
      ],
    ]);
    const originalGetMe = telegramService.getMe;
    telegramService.getMe = async () => ({ id: 1, username: 'alex' });
    try {
      await telegramService.updateUsername(sid, '@alex');
      assert.strictEqual(seenUsername, 'alex', 'expected @ to be stripped');
    } finally {
      telegramService.getMe = originalGetMe;
    }
  }

  console.log('updateUsername.notModifiedAsSuccess: OK');
}

// ──────────────────────────────────────────────────────────────────
// 3. _extractPhotoId
// ──────────────────────────────────────────────────────────────────
{
  // Real-shape response: { photo: { id: <bigint-like> }, users: [...] }
  const fake = { photo: { id: { toString: () => '7654321987654321' } } };
  const id = telegramService._extractPhotoId(fake);
  assert.strictEqual(typeof id, 'bigint', 'expected BigInt return');
  assert.strictEqual(id.toString(), '7654321987654321');

  assert.strictEqual(telegramService._extractPhotoId(null), null);
  assert.strictEqual(telegramService._extractPhotoId({}), null);
  assert.strictEqual(telegramService._extractPhotoId({ photo: null }), null);
  assert.strictEqual(telegramService._extractPhotoId({ photo: {} }), null);
  console.log('_extractPhotoId: OK');
}

// ──────────────────────────────────────────────────────────────────
// 4. _deletePriorProfilePhotos: only deletes prior photos
// ──────────────────────────────────────────────────────────────────
async function testDeletePriorPhotos() {
  const sid = '__deletePriorTest__';

  telegramService._ensureConnected = async () => {};
  telegramService._withFloodRetry = async (_s, fn) => fn();

  const NEW_ID = BigInt('100');
  const OLD_ID_A = BigInt('200');
  const OLD_ID_B = BigInt('300');

  // (a) Three photos in history (one is the new one) → delete the other two.
  {
    const invokeCalls = [];
    telegramService.clients = new Map([
      [
        sid,
        {
          client: {
            invoke: async (req) => {
              invokeCalls.push(req);
              const cn = (req && req.className) || '';
              if (/GetUserPhotos/i.test(cn)) {
                return {
                  photos: [
                    { className: 'Photo', id: NEW_ID, accessHash: BigInt('1111'), fileReference: Buffer.from([]) },
                    { className: 'Photo', id: OLD_ID_A, accessHash: BigInt('2222'), fileReference: Buffer.from([]) },
                    { className: 'Photo', id: OLD_ID_B, accessHash: BigInt('3333'), fileReference: Buffer.from([]) },
                  ],
                };
              }
              if (/DeletePhotos/i.test(cn)) {
                return [];
              }
              throw new Error('unexpected invoke ' + cn);
            },
          },
        },
      ],
    ]);

    const n = await telegramService._deletePriorProfilePhotos(sid, NEW_ID);
    assert.strictEqual(n, 2, 'expected 2 prior photos deleted');

    // Verify DeletePhotos received exactly the two old InputPhotos.
    const deleteReq = invokeCalls.find((c) => c && /DeletePhotos/i.test(c.className || ''));
    assert.ok(deleteReq, 'expected DeletePhotos invocation');
    assert.strictEqual(deleteReq.id.length, 2, 'expected exactly 2 InputPhoto entries');
    const deletedIds = deleteReq.id.map((ip) => BigInt(ip.id.toString())).sort();
    assert.deepStrictEqual(deletedIds, [OLD_ID_A, OLD_ID_B].sort());
  }

  // (b) When the user has no prior photos, DeletePhotos must not be called.
  {
    const invokeCalls = [];
    telegramService.clients = new Map([
      [
        sid,
        {
          client: {
            invoke: async (req) => {
              invokeCalls.push(req);
              if (req && /GetUserPhotos/i.test(req.className || '')) {
                return { photos: [{ className: 'Photo', id: NEW_ID, accessHash: BigInt(1), fileReference: Buffer.from([]) }] };
              }
              throw new Error('unexpected invoke ' + req.className);
            },
          },
        },
      ],
    ]);
    const n = await telegramService._deletePriorProfilePhotos(sid, NEW_ID);
    assert.strictEqual(n, 0, 'expected 0 prior photos deleted when none exist');
    assert.ok(
      !invokeCalls.some((c) => /DeletePhotos/i.test((c && c.className) || '')),
      'DeletePhotos must not be invoked when there is nothing to delete'
    );
  }

  // (c) When newPhotoId is null (extraction failed), delete EVERY photo so the
  //     stale ones can't shadow the freshly uploaded avatar.
  {
    const invokeCalls = [];
    telegramService.clients = new Map([
      [
        sid,
        {
          client: {
            invoke: async (req) => {
              invokeCalls.push(req);
              if (req && /GetUserPhotos/i.test(req.className || '')) {
                return {
                  photos: [
                    { className: 'Photo', id: OLD_ID_A, accessHash: BigInt(1), fileReference: Buffer.from([]) },
                    { className: 'Photo', id: OLD_ID_B, accessHash: BigInt(2), fileReference: Buffer.from([]) },
                  ],
                };
              }
              if (/DeletePhotos/i.test(req.className || '')) return [];
              throw new Error('unexpected invoke');
            },
          },
        },
      ],
    ]);
    const n = await telegramService._deletePriorProfilePhotos(sid, null);
    assert.strictEqual(n, 2, 'expected both photos deleted when newPhotoId is null');
  }

  console.log('_deletePriorProfilePhotos: OK');
}

// ──────────────────────────────────────────────────────────────────
// 5. updateProfilePhoto: cleanup failure must NOT poison the update
// ──────────────────────────────────────────────────────────────────
async function testPhotoCleanupResilience() {
  const sid = '__photoCleanupResilienceTest__';

  // Pick a real bundled avatar so the existsSync / statSync don't fail.
  const sample = randomAvatars.getAvatars()[0];
  assert.ok(sample, 'expected at least one bundled avatar for the test');

  telegramService._ensureConnected = async () => {};
  telegramService._withFloodRetry = async (_s, fn) => fn();

  telegramService.clients = new Map([
    [
      sid,
      {
        client: {
          uploadFile: async () => ({ className: 'InputFile' }),
          invoke: async (req) => {
            const cn = (req && req.className) || '';
            if (/UploadProfilePhoto/i.test(cn)) {
              return { photo: { id: { toString: () => '99999' } } };
            }
            if (/GetUserPhotos/i.test(cn)) {
              // Cleanup blows up — must not fail the whole call.
              throw new Error('500: INTERNAL (caused by photos.GetUserPhotos)');
            }
            throw new Error('unexpected invoke ' + cn);
          },
        },
      },
    ],
  ]);

  const result = await telegramService.updateProfilePhoto(sid, sample.absPath);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.updatedField, 'profile_photo');
  assert.strictEqual(result.deletedPriorPhotos, 0, 'cleanup failure -> reported zero deleted');
  console.log('updateProfilePhoto.cleanupResilience: OK');
}

// Sequence the async test bodies so they don't race over the shared
// telegramService singleton (each block replaces .clients / ._withFloodRetry).
(async () => {
  await testUsernameNotModified();
  await testDeletePriorPhotos();
  await testPhotoCleanupResilience();
  console.log('\nAll accountSettingsFixes smoke checks passed.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
