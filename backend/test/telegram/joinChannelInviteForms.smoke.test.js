/**
 * Smoke test for telegramService._parseInviteHash and the join/leave
 * invite-link branch in _resolveEntity.
 *
 * The pre-fix resolver only matched `https://t.me/joinchat/...` and
 * `https://t.me/+...`. Every other form Telegram clients emit
 * (scheme-less host, telegram.me mirror, tg:// deep link, bare hash)
 * fell through to the username branch and was rejected as "Could not
 * resolve target". Operators paste those forms constantly. This test
 * pins the parser so a future refactor can't drop coverage.
 *
 * No DB connection / no Telegram client \u2014 we instantiate the bare
 * service module and exercise the pure helper.
 */

'use strict';

const assert = require('assert');

// telegramService.js wires up a global instance on require, with
// constructor-side dependencies on DB / Redis / logger. The pure
// `_parseInviteHash` helper has no such dependencies, but to avoid
// booting the whole service we lift it out of the source by `require`
// then bind it as a free function. If the service refactors and the
// helper moves, this test will fail at require time and we'll know.
const telegramService = require('../../src/services/telegramService');
const parseInviteHash = telegramService._parseInviteHash.bind(telegramService);

const CASES = [
  // Canonical forms (already supported)
  ['https://t.me/joinchat/AAAAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAAAA'],
  ['https://t.me/+AAAAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAAAA'],

  // Scheme-less forms (the panel's main reported breakage)
  ['t.me/+abcdef1234567890XYZW_', 'abcdef1234567890XYZW_'],
  ['t.me/joinchat/abcdef1234567890XYZW_', 'abcdef1234567890XYZW_'],
  ['www.t.me/+abcdef1234567890XYZW_', 'abcdef1234567890XYZW_'],

  // Mirror domain
  ['https://telegram.me/joinchat/abcdef1234567890XYZW_', 'abcdef1234567890XYZW_'],
  ['telegram.me/+abcdef1234567890XYZW_', 'abcdef1234567890XYZW_'],

  // tg:// deep link
  ['tg://join?invite=abcdef1234567890XYZW_', 'abcdef1234567890XYZW_'],
  // Deep link with extra query params surrounding the hash
  ['tg://join?ref=foo&invite=abcdef1234567890XYZW_', 'abcdef1234567890XYZW_'],

  // Bare hash (operator pasted just the share-link tail)
  ['abcdef1234567890XYZW_-', 'abcdef1234567890XYZW_-'],

  // Case-insensitivity on host/scheme
  ['HTTPS://T.ME/+abcdef1234567890XYZW_', 'abcdef1234567890XYZW_'],
  ['TG://JOIN?INVITE=abcdef1234567890XYZW_', 'abcdef1234567890XYZW_'],

  // Negative cases
  ['@example_group', null],
  ['example_group', null],          // too short (13 chars) AND no domain prefix
  ['https://t.me/example_group', null], // public username, not invite
  ['-1001234567890', null],         // numeric channel id
  ['+12025551234', null],           // phone number
  ['', null],
  [null, null],
  [undefined, null],
];

let pass = 0;
let fail = 0;
for (const [input, expected] of CASES) {
  const got = parseInviteHash(input);
  if (got === expected) {
    pass++;
  } else {
    fail++;
    console.error(
      `FAIL parseInviteHash(${JSON.stringify(input)}) => ${JSON.stringify(got)}, expected ${JSON.stringify(
        expected
      )}`
    );
  }
}

assert.strictEqual(fail, 0, `${fail} invite-link parser case(s) failed`);
console.log(`OK joinChannelInviteForms.smoke: ${pass}/${CASES.length} invite-link forms parsed correctly`);

// Additional invariants that pin the parser's contract.
assert.strictEqual(typeof telegramService._parseInviteHash, 'function',
  'telegramService must expose _parseInviteHash');
assert.strictEqual(parseInviteHash('a'.repeat(15)), null,
  'bare hash shorter than 16 chars must not match (avoids collision with usernames)');
assert.strictEqual(parseInviteHash('a'.repeat(64)), 'a'.repeat(64),
  'bare hash of 64 chars must match');
assert.strictEqual(parseInviteHash('a'.repeat(65)), null,
  'bare hash longer than 64 chars must not match');

console.log('joinChannelInviteForms.smoke.test: OK');
