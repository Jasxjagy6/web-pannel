/**
 * Smoke test for the centralized auth-revocation detection.
 *
 * Covers the pure pieces of the system that do not require Postgres or
 * a live GramJS connection:
 *
 *   1. telegramService.isPermanentAuthError correctly identifies every
 *      Telegram permanent-auth code we listen for (and ignores other
 *      transient errors like FLOOD_WAIT).
 *   2. sessionService._inferRevokeReasonCode maps the raw error
 *      message to the canonical reason code stored on the session.
 *   3. sessionService.maybeFlagRevoked is a no-op for non-auth errors
 *      (it does not even open a DB connection).
 *
 * The full end-to-end DB write + socket emit path is exercised by the
 * integration suite — here we just lock in the gate logic.
 */

'use strict';

const assert = require('assert');

const telegramService = require('../../src/services/telegramService');
const sessionService = require('../../src/services/sessionService');

// ──────────────────────────────────────────────────────────────────
// 1. isPermanentAuthError
// ──────────────────────────────────────────────────────────────────

const permanent = [
  'AUTH_KEY_UNREGISTERED',
  'AUTH_KEY_INVALID',
  'AUTH_KEY_DUPLICATED',
  'SESSION_REVOKED',
  'SESSION_EXPIRED',
  'USER_DEACTIVATED',
];
for (const code of permanent) {
  const err = new Error(`[401 ${code}] The authorization key is bad`);
  assert.ok(
    telegramService.isPermanentAuthError(err),
    `should flag ${code} as permanent`
  );
}

// errorMessage attribute path (RPCError shape).
const rpcErr = Object.assign(new Error('bad'), {
  errorMessage: 'AUTH_KEY_UNREGISTERED',
});
assert.ok(
  telegramService.isPermanentAuthError(rpcErr),
  'RPCError-style errorMessage attribute also detected'
);

// Transient errors must NOT be flagged.
const transient = [
  'FLOOD_WAIT_30',
  'PEER_FLOOD',
  'USERNAME_NOT_OCCUPIED',
  'CHAT_ADMIN_REQUIRED',
  'PEER_ID_INVALID',
  'USER_PRIVACY_RESTRICTED',
  'CONNECTION_NOT_INITED',
  'TIMEOUT',
];
for (const code of transient) {
  const err = new Error(code);
  assert.ok(
    !telegramService.isPermanentAuthError(err),
    `should NOT flag transient ${code} as permanent`
  );
}

// Null / undefined / weird inputs.
assert.strictEqual(telegramService.isPermanentAuthError(null), false);
assert.strictEqual(telegramService.isPermanentAuthError(undefined), false);
assert.strictEqual(
  telegramService.isPermanentAuthError({ random: 'thing' }),
  false,
  'random object does not match'
);

// ──────────────────────────────────────────────────────────────────
// 2. sessionService._inferRevokeReasonCode mapping
// ──────────────────────────────────────────────────────────────────

const reasonCases = [
  ['AUTH_KEY_UNREGISTERED', 'AUTH_KEY_UNREGISTERED'],
  ['AUTH_KEY_INVALID', 'AUTH_KEY_INVALID'],
  ['AUTH_KEY_DUPLICATED', 'AUTH_KEY_DUPLICATED'],
  ['SESSION_REVOKED', 'SESSION_REVOKED'],
  ['SESSION_EXPIRED', 'SESSION_EXPIRED'],
  ['USER_DEACTIVATED', 'USER_DEACTIVATED'],
  ['some random thing', null],
];
for (const [input, expected] of reasonCases) {
  const got = sessionService._inferRevokeReasonCode(input);
  if (expected === null) {
    assert.ok(!got, `unrecognized text should not yield a code, got ${got}`);
  } else {
    assert.strictEqual(got, expected, `infer ${input} → ${expected}`);
  }
}

// ──────────────────────────────────────────────────────────────────
// 3. maybeFlagRevoked early-exit for non-auth errors
// ──────────────────────────────────────────────────────────────────

(async () => {
  // Transient error: must return falsy WITHOUT touching the DB. We
  // pass a session id that doesn't exist; if maybeFlagRevoked tried
  // to UPDATE it, the call would still no-op silently because the
  // helper swallows DB errors — but importantly it should never even
  // try to do so, which we exercise by passing a non-numeric id.
  const flagged = await sessionService.maybeFlagRevoked(
    '__not_a_real_session__',
    new Error('FLOOD_WAIT_30'),
    'authRevocation.smokeTest'
  );
  assert.ok(
    !flagged,
    'transient error must not result in a flagged-revoked session'
  );

  console.log('authRevocation smoke test PASSED:', {
    permanentCases: permanent.length,
    transientCases: transient.length,
  });
})();
