/**
 * Smoke test for the Telegram /groups/add-members 400 fix.
 *
 * Reproduces and locks in the two regressions surfaced by the user's
 * 1170-row scrape export against `https://t.me/buyersgc`:
 *
 *   1. The validator's `userList` schema must accept rows where
 *      `telegram_id` is null/empty (handle-only scrape rows). Before
 *      the fix, every such row tripped Joi with
 *      `"userList[N].telegram_id" must be one of [string, number]`,
 *      which 400'd the entire request.
 *
 *   2. The normalizer must surface the full identifier chain
 *      (numeric id → @username → +phone). Scraped numeric ids usually
 *      can't be resolved without a cached access_hash, but a sibling
 *      `username` on the same row often resolves cleanly via
 *      `contacts.ResolveUsername` — `groupService.addMembersToGroups`
 *      walks the chain and falls through on resolution errors.
 */

'use strict';

const assert = require('assert');

const validator = require('../../src/middleware/validator');
const {
  collectTelegramTargetCandidates,
  normalizeTelegramTarget,
} = require('../../src/utils/telegramTargetNormalizer');

function expectValid(label, payload) {
  const { error, value } = validator.schemas.addMembersToGroup.validate(payload, {
    abortEarly: false,
  });
  if (error) {
    throw new Error(`[${label}] expected valid, got: ${error.message}`);
  }
  return value;
}

function expectInvalid(label, payload, needle) {
  const { error } = validator.schemas.addMembersToGroup.validate(payload, {
    abortEarly: false,
  });
  if (!error) {
    throw new Error(`[${label}] expected validation error, got valid payload`);
  }
  if (needle && !error.message.includes(needle)) {
    throw new Error(`[${label}] expected error to include "${needle}", got: ${error.message}`);
  }
}

// --- Validator: handle-only rows must be accepted ---

expectValid('numeric-id row', {
  sessionIds: [1],
  targetIds: ['https://t.me/buyersgc'],
  userList: [{ telegram_id: '5685747204', username: null }],
});

expectValid('handle-only row (telegram_id: null)', {
  sessionIds: [1],
  targetIds: ['https://t.me/buyersgc'],
  userList: [{ telegram_id: null, username: 'barry_keyes', first_name: 'Barry' }],
});

expectValid('mixed list with empty strings', {
  sessionIds: [1],
  targetIds: ['https://t.me/buyersgc'],
  userList: [
    { telegram_id: '8367369859', username: 'Cartio' },
    { telegram_id: '', username: 'durov', first_name: '' },
    { telegram_id: '6216658494' },
  ],
});

expectValid('sessionListId path (no sessionIds)', {
  sessionListId: 7,
  targetIds: ['https://t.me/buyersgc'],
  userList: [{ telegram_id: '6216658494' }],
});

expectInvalid(
  'must reject empty userList',
  {
    sessionIds: [1],
    targetIds: ['https://t.me/buyersgc'],
    userList: [],
  },
  'userList'
);

expectInvalid(
  'must require either targetIds or targetGroupId',
  {
    sessionIds: [1],
    userList: [{ telegram_id: '6216658494' }],
  },
  'targetIds'
);

// --- Candidate collection: id then username then phone ---

assert.deepStrictEqual(
  collectTelegramTargetCandidates({ telegram_id: '7977832875', username: 'Ba_Alan' }),
  ['7977832875', '@Ba_Alan'],
  'numeric+handle row should yield both candidates in id-first order'
);

assert.deepStrictEqual(
  collectTelegramTargetCandidates({ telegram_id: null, username: 'durov' }),
  ['@durov'],
  'handle-only row should yield just @username'
);

assert.deepStrictEqual(
  collectTelegramTargetCandidates({ telegram_id: '5685747204' }),
  ['5685747204'],
  'id-only row should yield just the numeric string'
);

assert.deepStrictEqual(
  collectTelegramTargetCandidates({ telegram_id: '2617dd5b-aaaa-bbbb-cccc-ddddeeeeffff' }),
  [],
  'UUID-style placeholder must be ignored'
);

assert.deepStrictEqual(
  collectTelegramTargetCandidates({ telegram_id: null, username: null, phone: '+919999999999' }),
  ['+919999999999'],
  'phone-only row should yield +phone'
);

assert.deepStrictEqual(
  collectTelegramTargetCandidates('@durov'),
  ['@durov'],
  'bare @username string must pass through'
);

assert.strictEqual(
  normalizeTelegramTarget({ telegram_id: '7977832875', username: 'Ba_Alan' }),
  '7977832875',
  'normalize should return the highest-priority candidate (id first)'
);

console.log('groupAddMembers.smoke.test: OK');
