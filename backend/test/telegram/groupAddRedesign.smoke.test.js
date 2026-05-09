/**
 * Smoke test for the institutional add-to-group redesign.
 *
 * Locks in the four invariants the operator asked for explicitly:
 *
 *   1. Source-aware deduplication: uploaded lists collapse duplicates
 *      by canonical key (id > username > phone); scraped lists
 *      (`source = 'job_<id>'`) are passed through untouched.
 *
 *   2. Numeric "username" rows collapse with their numeric-id sibling
 *      so a `(telegram_id=42, username='42')` pair counts as one.
 *
 *   3. Hard per-session burst cap: the distribution planner clamps
 *      `perSessionBurst` to `maxPerSessionBurst` (default 4 for
 *      `group_add`) across all auto bands — a 1000-user / 100-session
 *      job no longer plans 70 invites in a row.
 *
 *   4. Rows with no usable identifier are kept in the output (so the
 *      downstream `unaddressable` reporting still surfaces them) but
 *      duplicates with the same canonical key are dropped.
 */

'use strict';

const assert = require('assert');

const groupService = require('../../src/services/groupService');
const distributionPlanner = require('../../src/services/distributionPlanner');

const {
  dedupUploadedUserList,
  dedupKeyForEntry,
  isUploadedListSource,
  DEFAULT_MAX_ADDS_PER_SESSION,
} = groupService;

assert.strictEqual(typeof dedupUploadedUserList, 'function', 'dedupUploadedUserList must be exported');
assert.strictEqual(typeof dedupKeyForEntry, 'function', 'dedupKeyForEntry must be exported');
assert.strictEqual(typeof isUploadedListSource, 'function', 'isUploadedListSource must be exported');
assert.strictEqual(DEFAULT_MAX_ADDS_PER_SESSION, 4, 'Default per-session burst cap must be 4');

// -------------------------------------------------------------------
// 1. dedupKeyForEntry — canonical identity key
// -------------------------------------------------------------------
assert.strictEqual(dedupKeyForEntry({ telegram_id: '6434893178' }), 'id:6434893178');
assert.strictEqual(dedupKeyForEntry({ telegramId: 6434893178 }), 'id:6434893178');
assert.strictEqual(dedupKeyForEntry({ username: '@AliceX' }), 'u:alicex');
assert.strictEqual(dedupKeyForEntry({ username: 'AliceX' }), 'u:alicex');
assert.strictEqual(dedupKeyForEntry({ username: 'aliceX' }), 'u:alicex'); // case-insensitive
assert.strictEqual(dedupKeyForEntry({ phone: '+1 (415) 555-0100' }), 'p:+14155550100');
assert.strictEqual(dedupKeyForEntry({}), null);
assert.strictEqual(dedupKeyForEntry(null), null);
// Numeric "username" must collapse with numeric id namespace
assert.strictEqual(dedupKeyForEntry({ username: '6434893178' }), 'id:6434893178');
// id > username precedence
assert.strictEqual(
  dedupKeyForEntry({ telegram_id: '6434893178', username: 'alice' }),
  'id:6434893178'
);

// -------------------------------------------------------------------
// 2. isUploadedListSource — uploaded vs scraped detection
// -------------------------------------------------------------------
assert.strictEqual(isUploadedListSource(null), true,            'null source treated as uploaded');
assert.strictEqual(isUploadedListSource(''), true,              'empty source treated as uploaded');
assert.strictEqual(isUploadedListSource('import_csv'), true,    'import_csv is uploaded');
assert.strictEqual(isUploadedListSource('import_xlsx'), true,   'import_xlsx is uploaded');
assert.strictEqual(isUploadedListSource('import_txt'), true,    'import_txt is uploaded');
assert.strictEqual(isUploadedListSource('manual'), true,        'manual is uploaded');
assert.strictEqual(isUploadedListSource('manual_input'), true,  'manual_input is uploaded');
assert.strictEqual(isUploadedListSource('merge_1_2'), true,     'merged lists are uploaded');
assert.strictEqual(isUploadedListSource('job_42'), false,       'job_<id> is scraped');
assert.strictEqual(isUploadedListSource('job_abc-123'), false,  'job_<id> is scraped');
assert.strictEqual(isUploadedListSource('scrape_42'), false,    'scrape_<id> is scraped');
assert.strictEqual(isUploadedListSource('SCRAPED_42'), false,   'case-insensitive scraped detection');

// -------------------------------------------------------------------
// 3. dedupUploadedUserList — preserves order, drops duplicates
// -------------------------------------------------------------------
{
  const input = [
    { telegram_id: '111', username: 'alice' },        // [0] new: id:111
    { telegram_id: '222', username: 'bob' },          // [1] new: id:222
    { telegram_id: '111', username: 'alice' },        // dupe id:111 (drop)
    { telegram_id: '222', username: 'BOB' },          // dupe id:222 (drop)
    { username: 'alice' },                            // [2] new: u:alice (id keys are a separate namespace from u keys)
    { username: 'CHARLIE' },                          // [3] new: u:charlie
    { username: 'charlie' },                          // dupe u:charlie (drop)
    { telegram_id: '333', username: '333' },          // [4] new: id:333 (numeric "username" collapses to id namespace)
    { telegram_id: '333' },                           // dupe id:333 (drop)
    {},                                               // [5] unaddressable; kept as-is
    {},                                               // [6] unaddressable; kept as-is
  ];
  const { deduped, dropped } = dedupUploadedUserList(input);
  // Unique keys: id:111, id:222, u:alice, u:charlie, id:333 → 5 keyed rows
  // Plus 2 unaddressable (kept). Total = 7. Drops = 4.
  assert.strictEqual(dropped, 4, `expected 4 dropped, got ${dropped}`);
  assert.strictEqual(deduped.length, 7, `expected 7 surviving rows, got ${deduped.length}`);
  // Order preservation
  assert.strictEqual(deduped[0].telegram_id, '111');
  assert.strictEqual(deduped[1].telegram_id, '222');
  assert.strictEqual(deduped[2].username, 'alice');
  assert.strictEqual(deduped[3].username, 'CHARLIE');
  assert.strictEqual(deduped[4].telegram_id, '333');
}

// Empty / null input
{
  const { deduped, dropped } = dedupUploadedUserList([]);
  assert.deepStrictEqual(deduped, []);
  assert.strictEqual(dropped, 0);
}
{
  const { deduped, dropped } = dedupUploadedUserList(null);
  assert.deepStrictEqual(deduped, []);
  assert.strictEqual(dropped, 0);
}

// -------------------------------------------------------------------
// 4. Distribution planner enforces the hard 4/burst cap for group_add
// -------------------------------------------------------------------

// Auto mode, large ratio (1000 users / 5 sessions = 200) — old policy
// would have picked perSessionBurst=70. The new clamp must keep it at
// the default ceiling (4).
{
  const plan = distributionPlanner.plan({
    totalItems: 1000,
    sessionIds: ['s1', 's2', 's3', 's4', 's5'],
    workType: 'group_add',
    mode: 'auto',
  });
  assert.strictEqual(plan.maxPerSessionBurst, 4,
    `default maxPerSessionBurst should be 4, got ${plan.maxPerSessionBurst}`);
  assert.ok(plan.perSessionBurst <= 4,
    `auto perSessionBurst must be ≤ 4 (got ${plan.perSessionBurst})`);
  // With 1000 items and 5 × 4 = 20 slots per round, we need 50 rounds.
  assert.ok(plan.rounds >= 1);
}

// Manual mode: operator explicitly asked for 50 — runner clamps to 4.
{
  const plan = distributionPlanner.plan({
    totalItems: 1000,
    sessionIds: ['s1', 's2', 's3'],
    workType: 'group_add',
    mode: 'manual',
    perSessionBurst: 50,
    cooldownSecMin: 60,
    cooldownSecMax: 120,
    itemDelayMsMin: 30000,
    itemDelayMsMax: 60000,
  });
  assert.strictEqual(plan.perSessionBurst, 4,
    `manual perSessionBurst must be clamped to 4 (got ${plan.perSessionBurst})`);
}

// Operator override: maxPerSessionBurst=8 raises the ceiling.
{
  const plan = distributionPlanner.plan({
    totalItems: 1000,
    sessionIds: ['s1', 's2'],
    workType: 'group_add',
    mode: 'manual',
    perSessionBurst: 50,
    maxPerSessionBurst: 8,
    cooldownSecMin: 60,
    cooldownSecMax: 120,
    itemDelayMsMin: 30000,
    itemDelayMsMax: 60000,
  });
  assert.strictEqual(plan.maxPerSessionBurst, 8);
  assert.strictEqual(plan.perSessionBurst, 8,
    `override should let perSessionBurst rise to 8 (got ${plan.perSessionBurst})`);
}

// bulk_message must NOT be subject to the 4/burst clamp — its rate
// limit profile is different.
{
  const plan = distributionPlanner.plan({
    totalItems: 1000,
    sessionIds: ['s1', 's2', 's3'],
    workType: 'bulk_message',
    mode: 'auto',
  });
  assert.ok(plan.perSessionBurst > 4,
    `bulk_message auto burst should not be clamped to 4 (got ${plan.perSessionBurst})`);
}

console.log('[OK] groupAddRedesign smoke test passed');
