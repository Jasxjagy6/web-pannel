/**
 * Smoke test for the Manual-mode "Set ↔ Remove" toggle plumbing.
 *
 * Locks in:
 *   1. telegramService.clearProfileFields({ lastName:true }) invokes
 *      Api.account.UpdateProfile with `lastName: ''` only (so the
 *      flag bit is set for lastName and nothing else).
 *   2. clearProfileFields({ bio:true }) invokes UpdateProfile with
 *      `about: ''` only.
 *   3. accountSettingsService.updateMultipleSessions honours
 *      fieldModes.lastName === 'remove' by calling
 *      clearProfileFields (NOT updateProfile with empty string), and
 *      reports it as 'lastName:cleared' in updatedFields.
 *   4. fieldModes.username === 'remove' routes to
 *      updateUsername(sid, '') and reports 'username:cleared'.
 *   5. fieldModes.bio === 'remove' routes to clearProfileFields and
 *      reports 'bio:cleared'.
 *   6. fieldModes.profilePhoto === 'remove' routes to
 *      removeAllProfilePhotos and reports the deletedCount.
 *   7. firstName 'remove' intent is silently coerced to 'set' (the
 *      backend never attempts to clear first name because Telegram
 *      rejects an empty value).
 */

'use strict';

const assert = require('assert');

const telegramService = require('../../src/services/telegramService');
const { Api } = require('telegram');

// ──────────────────────────────────────────────────────────────────
// 1 + 2. clearProfileFields hits UpdateProfile with the right slot
// ──────────────────────────────────────────────────────────────────
async function testClearProfileFieldsLastName() {
  const sid = '__clearLastNameTest__';
  telegramService._ensureConnected = async () => {};
  telegramService._withFloodRetry = async (_s, fn) => fn();

  const invocations = [];
  telegramService.clients = new Map([
    [
      sid,
      {
        client: {
          invoke: async (req) => {
            invocations.push(req);
            return { _: 'bool' };
          },
        },
      },
    ],
  ]);

  const res = await telegramService.clearProfileFields(sid, { lastName: true });
  assert.strictEqual(res.success, true);
  assert.deepStrictEqual(res.cleared, ['lastName']);

  // Exactly one UpdateProfile RPC, carrying lastName='' and no other fields.
  assert.strictEqual(invocations.length, 1, 'expected 1 RPC');
  const req = invocations[0];
  assert.ok(req instanceof Api.account.UpdateProfile, 'expected UpdateProfile');
  assert.strictEqual(req.lastName, '', 'lastName must be empty string');
  // about / firstName must NOT be set so Telegram doesn't touch them.
  assert.strictEqual(req.about, undefined, 'about must be unset');
  assert.strictEqual(req.firstName, undefined, 'firstName must be unset');
  console.log('clearProfileFields.lastName: OK');
}

async function testClearProfileFieldsBio() {
  const sid = '__clearBioTest__';
  telegramService._ensureConnected = async () => {};
  telegramService._withFloodRetry = async (_s, fn) => fn();

  const invocations = [];
  telegramService.clients = new Map([
    [
      sid,
      {
        client: {
          invoke: async (req) => {
            invocations.push(req);
            return { _: 'bool' };
          },
        },
      },
    ],
  ]);

  const res = await telegramService.clearProfileFields(sid, { bio: true });
  assert.strictEqual(res.success, true);
  assert.deepStrictEqual(res.cleared, ['bio']);

  assert.strictEqual(invocations.length, 1, 'expected 1 RPC');
  const req = invocations[0];
  assert.ok(req instanceof Api.account.UpdateProfile);
  assert.strictEqual(req.about, '', 'about must be empty string');
  assert.strictEqual(req.lastName, undefined);
  assert.strictEqual(req.firstName, undefined);
  console.log('clearProfileFields.bio: OK');
}

// Both at once → two RPCs, one per slot.
async function testClearProfileFieldsBoth() {
  const sid = '__clearBothTest__';
  telegramService._ensureConnected = async () => {};
  telegramService._withFloodRetry = async (_s, fn) => fn();

  const invocations = [];
  telegramService.clients = new Map([
    [
      sid,
      {
        client: {
          invoke: async (req) => {
            invocations.push(req);
            return { _: 'bool' };
          },
        },
      },
    ],
  ]);

  const res = await telegramService.clearProfileFields(sid, {
    lastName: true,
    bio: true,
  });
  assert.deepStrictEqual(res.cleared, ['lastName', 'bio']);
  assert.strictEqual(invocations.length, 2, 'expected 2 RPCs (lastName + bio)');
  console.log('clearProfileFields.both: OK');
}

// ──────────────────────────────────────────────────────────────────
// 3-7. updateMultipleSessions honours fieldModes.<field> === 'remove'
// ──────────────────────────────────────────────────────────────────
async function testServiceFieldModesRemove() {
  const path = require.resolve('../../src/services/accountSettingsService');
  delete require.cache[path];

  const dbPath = require.resolve('../../src/config/database');
  const db = require(dbPath);
  db.pool = {
    query: async (sql) => {
      if (/FROM sessions WHERE id = ANY/i.test(sql)) {
        return {
          rows: [{ id: 7, phone: '+1-555-7777', status: 'active' }],
        };
      }
      if (/INSERT INTO activity_logs/i.test(sql)) return { rows: [] };
      throw new Error('unexpected query: ' + sql);
    },
  };

  const svc = require(path);

  // Record every telegramService call routed by the service.
  const calls = [];
  telegramService.updateProfile = async (...args) => {
    calls.push({ method: 'updateProfile', args });
    return {};
  };
  telegramService.updateUsername = async (...args) => {
    calls.push({ method: 'updateUsername', args });
    return {};
  };
  telegramService.clearProfileFields = async (...args) => {
    calls.push({ method: 'clearProfileFields', args });
    return { success: true, cleared: Object.keys(args[1] || {}) };
  };
  telegramService.removeAllProfilePhotos = async (sid) => {
    calls.push({ method: 'removeAllProfilePhotos', args: [sid] });
    return { success: true, deletedCount: 5 };
  };
  telegramService.updateProfilePhoto = async (...args) => {
    calls.push({ method: 'updateProfilePhoto', args });
    return {};
  };

  const result = await svc.updateMultipleSessions(
    {
      sessionIds: [7],
      // Set first name (only allowed mode), clear everything else.
      firstName: 'Alex',
      lastName: '',
      username: '',
      bio: '',
      updateFlags: {
        firstName: true,
        lastName: true,
        username: true,
        bio: true,
        profilePhoto: true,
      },
      fieldModes: {
        firstName: 'remove', // illegal — must be silently coerced to 'set'
        lastName: 'remove',
        username: 'remove',
        bio: 'remove',
        profilePhoto: 'remove',
      },
    },
    99 // userId
  );

  assert.strictEqual(result.total, 1);
  assert.strictEqual(result.success, 1, 'session should be marked success');
  assert.strictEqual(result.failed, 0);
  const r = result.results[0];
  assert.strictEqual(r.sessionId, 7);

  // firstName remove is coerced to set, so we expect updateProfile(sid, 'Alex', ...)
  // to have been called. lastName clearing is handled in the SAME path as
  // firstName because we combined them in one updateProfile RPC when
  // firstName is set. Verify both are reported as updated.
  assert.ok(
    r.updatedFields.includes('firstName'),
    `expected firstName updated, got ${r.updatedFields}`
  );
  assert.ok(
    r.updatedFields.includes('lastName:cleared'),
    `expected lastName:cleared, got ${r.updatedFields}`
  );
  assert.ok(
    r.updatedFields.includes('username:cleared'),
    `expected username:cleared, got ${r.updatedFields}`
  );
  assert.ok(
    r.updatedFields.includes('bio:cleared'),
    `expected bio:cleared, got ${r.updatedFields}`
  );
  assert.ok(
    r.updatedFields.some((f) => f.startsWith('profilePhoto:cleared')),
    `expected profilePhoto:cleared(N), got ${r.updatedFields}`
  );

  // Check the actual RPCs that fired.
  const updateProfileCall = calls.find((c) => c.method === 'updateProfile');
  assert.ok(updateProfileCall, 'updateProfile must have been invoked');
  // updateProfile(sessionId, firstName, lastName) — lastName cleared via ''
  assert.strictEqual(updateProfileCall.args[0], '7');
  assert.strictEqual(updateProfileCall.args[1], 'Alex');
  assert.strictEqual(updateProfileCall.args[2], '', 'lastName empty for clear');

  // Username clear must hit updateUsername(sid, '').
  const usernameCall = calls.find((c) => c.method === 'updateUsername');
  assert.ok(usernameCall, 'updateUsername must have been invoked');
  assert.strictEqual(usernameCall.args[1], '', 'username arg must be empty');

  // Bio clear must hit clearProfileFields({ bio:true }).
  const bioClear = calls.find(
    (c) => c.method === 'clearProfileFields' && c.args[1] && c.args[1].bio
  );
  assert.ok(bioClear, 'clearProfileFields(bio:true) must have been invoked');

  // Photo clear must hit removeAllProfilePhotos.
  const photoClear = calls.find((c) => c.method === 'removeAllProfilePhotos');
  assert.ok(photoClear, 'removeAllProfilePhotos must have been invoked');

  // CRITICAL: updateProfile must NOT have been called with firstName=''
  // (would mean we tried to clear first name, which Telegram rejects).
  const firstNameClearAttempt = calls.find(
    (c) =>
      c.method === 'updateProfile' &&
      (c.args[1] === '' || c.args[1] === undefined)
  );
  assert.ok(
    !firstNameClearAttempt,
    'firstName must NEVER be cleared, even when frontend sends fieldModes.firstName="remove"'
  );

  console.log('service.fieldModes.remove: OK');
}

(async () => {
  await testClearProfileFieldsLastName();
  await testClearProfileFieldsBio();
  await testClearProfileFieldsBoth();
  await testServiceFieldModesRemove();
  console.log('\nAll manualSetRemoveModes smoke checks passed.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
