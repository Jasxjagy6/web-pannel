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

// --- addMemberToGroup: contextual error translation ---
//
// When `messages.AddChatUser` / `channels.InviteToChannel` fail with
// CHAT_WRITE_FORBIDDEN, the panel must NOT surface "You cannot send
// messages in this chat" — operators reading that message reasonably
// thought the panel was using the wrong RPC. The catch block in
// `addMemberToGroup` translates the literal Telegram code into a
// message that reflects what actually happened in an add-members
// context (kicked / banned / restricted) while keeping `[CODE]`
// prefixed so downstream classifiers in `groupService` still match.
(async () => {
  const tg = require('../../src/services/telegramService');
  const sid = '__ctx_test__';

  const cases = [
    {
      label: 'CHAT_WRITE_FORBIDDEN',
      raw: 'CHAT_WRITE_FORBIDDEN',
      code: 'CHAT_WRITE_FORBIDDEN',
      needle: /kicked, banned, or restricted/,
    },
    {
      label: 'CHAT_ADMIN_REQUIRED',
      raw: 'CHAT_ADMIN_REQUIRED',
      code: 'CHAT_ADMIN_REQUIRED',
      needle: /must be an admin/,
    },
    {
      label: 'USER_NOT_PARTICIPANT',
      raw: 'USER_NOT_PARTICIPANT (caused by channels.InviteToChannel)',
      code: 'USER_NOT_PARTICIPANT',
      needle: /not a participant/,
    },
    {
      label: 'CHANNEL_PRIVATE',
      raw: 'CHANNEL_PRIVATE',
      code: 'CHANNEL_PRIVATE',
      needle: /lost access/,
    },
  ];

  for (const c of cases) {
    tg._ensureConnected = async () => {};
    tg.clients = new Map([[sid, {
      client: { invoke: async () => { throw new Error(c.raw); } },
    }]]);
    tg._resolveEntity = async (_s, target) => (target === '@buyersgc'
      ? { className: 'Channel', id: 1, accessHash: 1 }
      : { id: 2, accessHash: 2 });
    tg._withFloodRetry = async (_s, fn) => fn();

    let err;
    try {
      await tg.addMemberToGroup(sid, '@buyersgc', '12345');
    } catch (e) { err = e; }
    if (!err) throw new Error(`[${c.label}] expected throw`);
    if (err.code !== c.code) throw new Error(`[${c.label}] expected code ${c.code}, got ${err.code}`);
    if (!err.message.startsWith(`[${c.code}]`)) throw new Error(`[${c.label}] expected [${c.code}] prefix, got ${err.message}`);
    if (!c.needle.test(err.message)) throw new Error(`[${c.label}] expected ${c.needle}, got ${err.message}`);
    if (!err.message.includes('@buyersgc')) throw new Error(`[${c.label}] expected target name in message`);
  }
  console.log('addMemberToGroup.contextualErrors: OK');

// --- addMemberToGroup: silent-drop classification ---
//
// `channels.InviteToChannel` returns the same "empty updates + empty
// users" shape for two distinct cases:
//   1. The user was silently dropped (Telegram refused to add them
//      because of their privacy settings). The operator should see
//      USER_PRIVACY_RESTRICT.
//   2. The user was ALREADY a participant before this call, so no
//      state change happened. Operator quote (this is what we're
//      fixing): "Although both user jashanxjagy and Jagmeet were
//      successfully added to the groups (I check telegram and they
//      were in) but still pannel was showing user privacy restrict".
//
// The fix probes `channels.GetParticipant` whenever the silent-drop
// shape fires AND `missingInvitees` is empty — if the user is in,
// we throw USER_ALREADY_PARTICIPANT instead so the runner records
// the row as "User already in target" rather than a privacy reject.
//
// NOTE: this block is intentionally inside the same IIFE as the
// contextualErrors block above so the two don't race over the
// shared `tg.clients` / `tg._resolveEntity` mocks.
  {
  const sid = '__silent_drop_test__';

  // ── Case 1: empty response + GetParticipant says user is IN ──
  //    Expect USER_ALREADY_PARTICIPANT (NOT privacy restrict).
  {
    let getParticipantCalled = false;
    tg._ensureConnected = async () => {};
    tg.clients = new Map([[sid, {
      client: {
        invoke: async (req) => {
          const t = req && (req.className || req.__type) || '';
          if (/InviteToChannel/.test(t)) {
            // Layer 198-style empty wrapper.
            return {
              updates: { updates: [], users: [] },
              missingInvitees: [],
            };
          }
          if (/GetParticipant/.test(t)) {
            getParticipantCalled = true;
            return {
              participant: { className: 'ChannelParticipant' },
            };
          }
          throw new Error(`Unmocked RPC: ${t}`);
        },
      },
    }]]);
    tg._resolveEntity = async (_s, target) => (typeof target === 'string' && target.startsWith('@')
      ? { className: 'Channel', id: 1, accessHash: 1 }
      : { className: 'User', id: 2, accessHash: 2 });
    tg._withFloodRetry = async (_s, fn) => fn();

    let err = null;
    try {
      await tg.addMemberToGroup(sid, '@group', '12345');
    } catch (e) { err = e; }
    if (!err) throw new Error('expected throw');
    if (!err.message.includes('USER_ALREADY_PARTICIPANT')) {
      throw new Error(
        `expected USER_ALREADY_PARTICIPANT, got: ${err.message}`
      );
    }
    if (!getParticipantCalled) {
      throw new Error('expected channels.GetParticipant probe to be called');
    }
  }

  // ── Case 2: empty response + GetParticipant says user is LEFT ──
  //    Expect USER_PRIVACY_RESTRICT (existing behaviour).
  {
    tg._ensureConnected = async () => {};
    tg.clients = new Map([[sid, {
      client: {
        invoke: async (req) => {
          const t = req && (req.className || req.__type) || '';
          if (/InviteToChannel/.test(t)) {
            return {
              updates: { updates: [], users: [] },
              missingInvitees: [],
            };
          }
          if (/GetParticipant/.test(t)) {
            return {
              participant: { className: 'ChannelParticipantLeft' },
            };
          }
          throw new Error(`Unmocked RPC: ${t}`);
        },
      },
    }]]);
    tg._resolveEntity = async (_s, target) => (typeof target === 'string' && target.startsWith('@')
      ? { className: 'Channel', id: 1, accessHash: 1 }
      : { className: 'User', id: 2, accessHash: 2 });
    tg._withFloodRetry = async (_s, fn) => fn();

    let err = null;
    try {
      await tg.addMemberToGroup(sid, '@group', '12345');
    } catch (e) { err = e; }
    if (!err) throw new Error('expected throw');
    if (!err.message.includes('USER_PRIVACY_RESTRICT')) {
      throw new Error(
        `expected USER_PRIVACY_RESTRICT when user is not a participant, got: ${err.message}`
      );
    }
  }

  // ── Case 3: missingInvitees populated → DON'T probe ──
  //    Telegram explicitly populated `missingInvitees` so we already
  //    know the user was the one dropped. The probe must NOT be
  //    called (it would be a wasted RPC).
  {
    let getParticipantCalled = false;
    tg._ensureConnected = async () => {};
    tg.clients = new Map([[sid, {
      client: {
        invoke: async (req) => {
          const t = req && (req.className || req.__type) || '';
          if (/InviteToChannel/.test(t)) {
            return {
              updates: { updates: [], users: [] },
              missingInvitees: [
                { userId: 12345, premiumWouldAllowInvite: false },
              ],
            };
          }
          if (/GetParticipant/.test(t)) {
            getParticipantCalled = true;
            return { participant: { className: 'ChannelParticipant' } };
          }
          throw new Error(`Unmocked RPC: ${t}`);
        },
      },
    }]]);
    tg._resolveEntity = async (_s, target) => (typeof target === 'string' && target.startsWith('@')
      ? { className: 'Channel', id: 1, accessHash: 1 }
      : { className: 'User', id: 2, accessHash: 2 });
    tg._withFloodRetry = async (_s, fn) => fn();

    let err = null;
    try {
      await tg.addMemberToGroup(sid, '@group', '12345');
    } catch (e) { err = e; }
    if (!err) throw new Error('expected throw');
    if (!err.message.includes('USER_PRIVACY_RESTRICT')) {
      throw new Error(
        `expected USER_PRIVACY_RESTRICT when missingInvitees is populated, got: ${err.message}`
      );
    }
    if (getParticipantCalled) {
      throw new Error(
        'channels.GetParticipant must NOT be called when missingInvitees is populated'
      );
    }
  }

  // ── Case 4: empty response + GetParticipant throws USER_NOT_PARTICIPANT ──
  //    Fall back to USER_PRIVACY_RESTRICT. The probe error is the
  //    canonical "genuinely not in the group" answer.
  {
    tg._ensureConnected = async () => {};
    tg.clients = new Map([[sid, {
      client: {
        invoke: async (req) => {
          const t = req && (req.className || req.__type) || '';
          if (/InviteToChannel/.test(t)) {
            return {
              updates: { updates: [], users: [] },
              missingInvitees: [],
            };
          }
          if (/GetParticipant/.test(t)) {
            throw new Error('USER_NOT_PARTICIPANT (caused by channels.GetParticipant)');
          }
          throw new Error(`Unmocked RPC: ${t}`);
        },
      },
    }]]);
    tg._resolveEntity = async (_s, target) => (typeof target === 'string' && target.startsWith('@')
      ? { className: 'Channel', id: 1, accessHash: 1 }
      : { className: 'User', id: 2, accessHash: 2 });
    tg._withFloodRetry = async (_s, fn) => fn();

    let err = null;
    try {
      await tg.addMemberToGroup(sid, '@group', '12345');
    } catch (e) { err = e; }
    if (!err) throw new Error('expected throw');
    if (!err.message.includes('USER_PRIVACY_RESTRICT')) {
      throw new Error(
        `expected USER_PRIVACY_RESTRICT when probe says USER_NOT_PARTICIPANT, got: ${err.message}`
      );
    }
  }

  console.log('addMemberToGroup.silentDropDisambiguation: OK');
  }
})().catch((e) => { console.error(e); process.exit(1); });

console.log('groupAddMembers.smoke.test: OK');
