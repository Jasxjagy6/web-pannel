/**
 * Smoke test for the new "Profile List" account-settings flow.
 *
 * Locks in:
 *   1. listService.__internal.parseProfileListContent correctly handles
 *      the numbered-block format used by the operator's example file
 *      (`1.\nName: ...\nUsername: @...\nBio: ...\nPFP: ...`).
 *   2. The parser strips the leading `@` from usernames and ignores
 *      the "PFP" field (used as a free-text description, not a URL).
 *   3. Profile-list entries with no username (name + bio only) are
 *      preserved — the operator's example sheet has many such rows.
 *   4. accountSettingsService.__internal.buildProfileListAssignments
 *      cycles entries when there are more sessions than rows, appends
 *      a random suffix to repeated usernames (so no two sessions ever
 *      claim the same handle), and assigns a random avatar from the
 *      bundled catalog per session.
 *   5. The avatar catalog (data/randomAvatars/index.js) sees the 150+
 *      real images we seeded.
 */

'use strict';

const assert = require('assert');

const listService = require('../../src/services/listService');
const accountSettingsService = require('../../src/services/accountSettingsService');
const randomAvatars = require('../../src/data/randomAvatars');

const { parseProfileListContent } = listService.__internal;
const { buildProfileListAssignments, randomUsernameSuffix } =
  accountSettingsService.__internal;

// ──────────────────────────────────────────────────────────────────
// 1. parseProfileListContent — numbered block format
// ──────────────────────────────────────────────────────────────────

const SAMPLE = `
1.
Name: Marc Williams
Username: @marcw88
Bio: Crypto enthusiast, building the future
PFP: anime portrait, blue background

2.
Name: Sara Kim
Username: @sara_kim
Bio: Love hiking and reading

3.
Name: Anonymous
Bio: Just here for the vibes
`;

const parsed = parseProfileListContent(SAMPLE);
assert.strictEqual(parsed.length, 3, 'expected three parsed entries');

assert.strictEqual(parsed[0].first_name, 'Marc', 'parsed first_name');
assert.strictEqual(parsed[0].last_name, 'Williams', 'parsed last_name');
assert.strictEqual(parsed[0].username, 'marcw88', 'username @ stripped');
assert.ok(
  parsed[0].bio.startsWith('Crypto'),
  'bio captured from numbered block'
);

assert.strictEqual(parsed[1].username, 'sara_kim');
assert.strictEqual(parsed[1].first_name, 'Sara');

// Name-only entry — bio set, no username.
assert.strictEqual(parsed[2].first_name, 'Anonymous');
assert.strictEqual(parsed[2].username, null, 'no username row kept');
assert.ok(parsed[2].bio.includes('vibes'));

// ──────────────────────────────────────────────────────────────────
// 2. randomUsernameSuffix — predictable shape
// ──────────────────────────────────────────────────────────────────

for (let i = 0; i < 5; i++) {
  const s = randomUsernameSuffix();
  assert.ok(/^_[a-z0-9]{4}$/.test(s), `suffix shape: ${s}`);
}

// ──────────────────────────────────────────────────────────────────
// 3. buildProfileListAssignments — repeats + unique usernames
// ──────────────────────────────────────────────────────────────────

const profileItems = [
  { firstName: 'Marc', lastName: 'Williams', username: 'marcw88', bio: 'A' },
  { firstName: 'Sara', lastName: 'Kim', username: 'sara_kim', bio: 'B' },
];
const sessionIds = [101, 102, 103, 104, 105];
const avatarIds = randomAvatars.AVATAR_IDS.slice();

const assignments = buildProfileListAssignments(
  profileItems,
  sessionIds,
  avatarIds
);

assert.strictEqual(assignments.length, 5, '5 sessions → 5 assignments');

// Slot 0 should keep the bare username; slot 2 onwards (the first
// repeat of marcw88) should have a suffix appended.
assert.strictEqual(assignments[0].username, 'marcw88', 'first use bare');
assert.strictEqual(assignments[1].username, 'sara_kim');
assert.ok(
  /^marcw88_[a-z0-9]{4}$/.test(assignments[2].username),
  `repeat marcw88 got suffix, got: ${assignments[2].username}`
);
assert.ok(
  /^sara_kim_[a-z0-9]{4}$/.test(assignments[3].username),
  `repeat sara_kim got suffix, got: ${assignments[3].username}`
);
assert.ok(
  /^marcw88_[a-z0-9]{4}$/.test(assignments[4].username),
  'second repeat marcw88 also suffixed'
);

// Every username must be unique (case-insensitive). This is the
// core invariant the operator asked for: "in case of repeat some
// more random words should be added".
const seen = new Set();
for (const a of assignments) {
  assert.ok(a.username, 'every assignment has a username here');
  const k = a.username.toLowerCase();
  assert.ok(!seen.has(k), `duplicate username produced: ${a.username}`);
  seen.add(k);
}

// ──────────────────────────────────────────────────────────────────
// 3b. buildProfileListAssignments — list row with NO username should
//      produce clearUsername=true so the apply path calls
//      account.UpdateUsername('') and wipes the session's handle.
// ──────────────────────────────────────────────────────────────────
const mixedItems = [
  { firstName: 'Marc', lastName: 'W', username: 'marcw88', bio: 'A' },
  { firstName: 'Anonymous', username: null, bio: 'no handle' },
];
// 4 sessions, 2 items → indices [0:marc, 1:anon, 2:marc_repeat, 3:anon_repeat]
const mixedAssignments = buildProfileListAssignments(
  mixedItems,
  [201, 202, 203, 204],
  avatarIds
);
assert.strictEqual(mixedAssignments[0].username, 'marcw88');
assert.strictEqual(mixedAssignments[0].clearUsername, undefined);

// Row 1 has no username → must be flagged clearUsername=true with
// an empty username string the apply path can pass through.
assert.strictEqual(
  mixedAssignments[1].clearUsername,
  true,
  'row without username sets clearUsername=true'
);
assert.strictEqual(
  mixedAssignments[1].username,
  '',
  'username is empty string when clearing'
);

// Row 2 is a repeat of the named row → suffixed username, NOT clearing.
assert.ok(
  /^marcw88_[a-z0-9]{4}$/.test(mixedAssignments[2].username),
  `row 2 should be a suffixed marcw88, got ${mixedAssignments[2].username}`
);
assert.strictEqual(mixedAssignments[2].clearUsername, undefined);

// Row 3 is the second occurrence of the no-username item → also clear.
assert.strictEqual(mixedAssignments[3].clearUsername, true);
assert.strictEqual(mixedAssignments[3].username, '');

// Name + bio are allowed to repeat (operator explicitly asked).
assert.strictEqual(
  assignments[0].firstName,
  assignments[2].firstName,
  'name repeats across the same row'
);
assert.strictEqual(assignments[0].bio, assignments[2].bio);

// Every assignment got an avatar (catalog is non-empty), and they're
// drawn from the real bundled catalog, not synthesized.
for (const a of assignments) {
  assert.ok(a.avatarId, `every session got an avatar: ${JSON.stringify(a)}`);
  assert.ok(
    avatarIds.includes(a.avatarId),
    `avatarId is from the bundled catalog: ${a.avatarId}`
  );
}

// ──────────────────────────────────────────────────────────────────
// 4. buildProfileListAssignments — flag toggles
// ──────────────────────────────────────────────────────────────────

const noPhotoAssignments = buildProfileListAssignments(
  profileItems,
  sessionIds.slice(0, 2),
  avatarIds,
  { updatePhotos: false }
);
for (const a of noPhotoAssignments) {
  assert.strictEqual(
    a.avatarId,
    undefined,
    'updatePhotos:false suppresses avatar assignment'
  );
}

const noUsernameAssignments = buildProfileListAssignments(
  profileItems,
  sessionIds.slice(0, 2),
  avatarIds,
  { updateUsernames: false }
);
for (const a of noUsernameAssignments) {
  assert.strictEqual(
    a.username,
    undefined,
    'updateUsernames:false suppresses username assignment'
  );
}

// ──────────────────────────────────────────────────────────────────
// 5. Avatar catalog — 150+ real entries
// ──────────────────────────────────────────────────────────────────

assert.ok(
  randomAvatars.AVATAR_IDS.length >= 150,
  `expected 150+ bundled avatars, got ${randomAvatars.AVATAR_IDS.length}`
);

const avatarsMeta = randomAvatars.getAvatars();
for (const a of avatarsMeta.slice(0, 5)) {
  assert.ok(a.fileName, 'avatar entry has a fileName');
  assert.ok(/\.(png|jpe?g)$/i.test(a.fileName), `image extension on ${a.fileName}`);
}

// ──────────────────────────────────────────────────────────────────
console.log(
  'profileList smoke test PASSED:',
  `${parsed.length} parsed, ${assignments.length} assignments, ` +
    `${randomAvatars.AVATAR_IDS.length} avatars catalogued`
);
