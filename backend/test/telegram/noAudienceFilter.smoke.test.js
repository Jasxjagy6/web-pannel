/**
 * Regression test: the audience filtering system is fully removed.
 *
 * This locks in the operator's "remove the filtering users system
 * completly … the pannel should try to send messages, add members
 * or whatever task is given without skipping or filtering anything"
 * directive. If anyone re-introduces audienceFilterService, a probe
 * pipeline, or a "don't even attempt this row" pre-classifier, this
 * test fails.
 *
 * Concretely it asserts:
 *   1. `audienceFilterService.js` no longer exists.
 *   2. messageService and groupService no longer require / call any
 *      audience-filter-shaped surface.
 *   3. The two private helpers that gated the filter
 *      (`isUploadedListSourceString`, `_isUploadedListById`) are gone
 *      from messageService.
 *   4. Neither service references the in-flight runner cache update
 *      hook (`recordObservedFromEntry`).
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SVCS = path.resolve(__dirname, '..', '..', 'src', 'services');
const MESSAGE_PATH = path.join(SVCS, 'messageService.js');
const GROUP_PATH = path.join(SVCS, 'groupService.js');
const FILTER_PATH = path.join(SVCS, 'audienceFilterService.js');

function readSource(p) {
  return fs.readFileSync(p, 'utf8');
}

// 1. The service file itself is gone.
assert.strictEqual(
  fs.existsSync(FILTER_PATH),
  false,
  `audienceFilterService.js must be deleted; still present at ${FILTER_PATH}`
);

// 2. Neither service requires it.
const FORBIDDEN_REQUIRES = [
  "require('./audienceFilterService')",
  'require("./audienceFilterService")',
];

for (const file of [MESSAGE_PATH, GROUP_PATH]) {
  const src = readSource(file);
  for (const needle of FORBIDDEN_REQUIRES) {
    assert.ok(
      !src.includes(needle),
      `${path.basename(file)} must not require audienceFilterService (found "${needle}")`
    );
  }
}

// 3. No audience-filter symbols remain in either service.
const FORBIDDEN_SYMBOLS = [
  'audienceFilter',
  'audienceFilterService',
  'filterUserList',
  'recordObservedFromEntry',
  'audienceStats',
  'audienceDmOnly',
  'audienceDropped',
];

for (const file of [MESSAGE_PATH, GROUP_PATH]) {
  const src = readSource(file);
  for (const sym of FORBIDDEN_SYMBOLS) {
    assert.ok(
      !src.includes(sym),
      `${path.basename(file)} must not reference "${sym}" (audience filter is removed)`
    );
  }
}

// 4. The list-source gate helpers in messageService are gone.
{
  const src = readSource(MESSAGE_PATH);
  assert.ok(
    !src.includes('isUploadedListSourceString'),
    'messageService.js must not export isUploadedListSourceString anymore'
  );
  assert.ok(
    !src.includes('_isUploadedListById'),
    'messageService.js must not export _isUploadedListById anymore'
  );
}

// 5. Legacy phase emit was removed from groupService.
{
  const src = readSource(GROUP_PATH);
  assert.ok(
    !/markPhase\(['"]filtering['"]/.test(src),
    "groupService.js must not emit the 'filtering' phase anymore"
  );
}

// 6. The in-job dead-target cache (a second skip mechanism) is gone
//    from messageService. Per the operator's "no session should skip
//    the job unless session is not active" rule, no target-side
//    classifier may pre-empt sibling sessions from attempting a
//    target. Locks in the @binolt regression where 12 sessions were
//    blocked from sending after only 2 cold sessions reported "No
//    user has X" while 4 other sessions in the same job had already
//    sent to that user successfully.
{
  const src = readSource(MESSAGE_PATH);
  const FORBIDDEN_DEAD_TARGET = [
    'deadTargets',
    'targetFailureSessions',
    'TARGET_DEAD_CONFIRMATIONS',
    'isUnresolvableTargetError',
    'alive-session confirmations',
  ];
  for (const sym of FORBIDDEN_DEAD_TARGET) {
    assert.ok(
      !src.includes(sym),
      `messageService.js must not reference "${sym}" (dead-target cache is removed)`
    );
  }
}

// 7. The cross-session user-skip cache is gone from groupService.
//    Same rule: one session reporting USER_PRIVACY_RESTRICT or
//    USERNAME_NOT_OCCUPIED on a user must not block other sessions
//    in the same job from attempting that user.
{
  const src = readSource(GROUP_PATH);
  const FORBIDDEN_USER_SKIP = [
    'inJobSkipReasons',
    'lookupSkip',
    'markSkip',
    'priorSkip',
  ];
  for (const sym of FORBIDDEN_USER_SKIP) {
    assert.ok(
      !src.includes(sym),
      `groupService.js must not reference "${sym}" (cross-session user skip cache is removed)`
    );
  }
}

console.log('noAudienceFilter.smoke.test: OK');
