/**
 * Smoke test for the three-state outcome contract on
 * telegramService.joinChannel.
 *
 * Before this fix, both `INVITE_REQUEST_SENT` and
 * `USER_ALREADY_PARTICIPANT` propagated out of `joinChannel` as
 * exceptions, which the bulk runner counted as failures. The new
 * implementation maps them onto status='requested' /
 * status='already_member' so the panel can split them out from real
 * failures. This test stubs the GramJS client and asserts the mapping.
 *
 * No DB / Redis / live Telegram \u2014 we replace the service's `clients`
 * map with a fake object that exposes the minimum surface
 * (`client.invoke`, `client.connected`) and stub `_ensureConnected` to
 * a no-op.
 */

'use strict';

const assert = require('assert');

const telegramService = require('../../src/services/telegramService');

function makeStubClient(invokeImpl) {
  return {
    client: {
      connected: true,
      invoke: invokeImpl,
    },
  };
}

async function withStubbedSession(sessionId, invokeImpl, fn) {
  const origEnsure = telegramService._ensureConnected;
  const origFloodRetry = telegramService._withFloodRetry;
  const origClients = telegramService.clients;

  // Replace clients with a Map containing just our stub.
  telegramService.clients = new Map([[String(sessionId), makeStubClient(invokeImpl)]]);
  telegramService._ensureConnected = async () => {};
  // Run the inner function directly \u2014 we don't need flood retries here
  // and they pull in process.env / sleep loops we want to skip.
  telegramService._withFloodRetry = async (_sid, inner) => inner();

  try {
    return await fn();
  } finally {
    telegramService._ensureConnected = origEnsure;
    telegramService._withFloodRetry = origFloodRetry;
    telegramService.clients = origClients;
  }
}

function tlError(msg) {
  const e = new Error(msg);
  e.errorMessage = msg;
  return e;
}

(async () => {
  const SESSION = 9001;

  // ---- 1. Invite-link path: ChatInviteAlready -> already_member ----
  await withStubbedSession(
    SESSION,
    async (req) => {
      const cls = req && req.className;
      if (cls === 'messages.CheckChatInvite') {
        return {
          className: 'ChatInviteAlready',
          chat: { className: 'Channel', id: BigInt(123), title: 'Already Joined', username: null },
        };
      }
      throw new Error(`unexpected call: ${cls}`);
    },
    async () => {
      const result = await telegramService.joinChannel(
        SESSION,
        'https://t.me/+alreadyMemberHash11111'
      );
      assert.strictEqual(result.status, 'already_member',
        'ChatInviteAlready must produce status=already_member');
      assert.strictEqual(result.skipped, true,
        'already_member must mark skipped:true for legacy bulk-runner buckets');
      assert.strictEqual(result.success, true);
      assert.ok(result.targetName, 'targetName should come from chat.title');
      console.log('OK ChatInviteAlready -> already_member');
    }
  );

  // ---- 2. Invite-link path: ImportChatInvite raises INVITE_REQUEST_SENT -> requested ----
  await withStubbedSession(
    SESSION,
    async (req) => {
      const cls = req && req.className;
      if (cls === 'messages.CheckChatInvite') {
        return {
          className: 'ChatInvite',
          title: 'Approval-Required Group',
          requestNeeded: true,
        };
      }
      if (cls === 'messages.ImportChatInvite') {
        throw tlError('INVITE_REQUEST_SENT');
      }
      throw new Error(`unexpected call: ${cls}`);
    },
    async () => {
      const result = await telegramService.joinChannel(
        SESSION,
        'https://t.me/+pendingApprovalHash11111'
      );
      assert.strictEqual(result.status, 'requested',
        'INVITE_REQUEST_SENT from ImportChatInvite must produce status=requested');
      assert.strictEqual(result.success, true,
        'requested outcome must report success:true so the runner does not count it as a failure');
      assert.notStrictEqual(result.skipped, true,
        'requested must NOT be skipped (action was taken on the server side)');
      console.log('OK INVITE_REQUEST_SENT (invite-link) -> requested');
    }
  );

  // ---- 3. Invite-link path: ImportChatInvite raises USER_ALREADY_PARTICIPANT -> already_member
  await withStubbedSession(
    SESSION,
    async (req) => {
      const cls = req && req.className;
      if (cls === 'messages.CheckChatInvite') {
        return { className: 'ChatInvite', title: 'Race-with-ourselves', requestNeeded: false };
      }
      if (cls === 'messages.ImportChatInvite') {
        throw tlError('USER_ALREADY_PARTICIPANT');
      }
      throw new Error(`unexpected call: ${cls}`);
    },
    async () => {
      const result = await telegramService.joinChannel(
        SESSION,
        'https://t.me/+raceConditionHash11111'
      );
      assert.strictEqual(result.status, 'already_member',
        'USER_ALREADY_PARTICIPANT from ImportChatInvite must collapse to already_member');
      assert.strictEqual(result.skipped, true);
      console.log('OK USER_ALREADY_PARTICIPANT (invite-link) -> already_member');
    }
  );

  // ---- 4. Public path: channels.JoinChannel raises INVITE_REQUEST_SENT -> requested ----
  // Public channels with "request to join" enabled raise the same TL
  // error as invite-link imports do. We test the path that goes
  // through _resolveEntity + channels.JoinChannel.
  await withStubbedSession(
    SESSION,
    async (req) => {
      const cls = req && req.className;
      if (cls === 'channels.JoinChannel') {
        throw tlError('INVITE_REQUEST_SENT');
      }
      throw new Error(`unexpected call: ${cls}`);
    },
    async () => {
      // Bypass _resolveEntity by stubbing it directly.
      const orig = telegramService._resolveEntity;
      telegramService._resolveEntity = async () => ({
        className: 'Channel',
        id: BigInt(99),
        accessHash: BigInt(123),
        title: 'Approval-Required Public Channel',
        username: 'approve_channel',
      });
      try {
        const result = await telegramService.joinChannel(SESSION, '@approve_channel');
        assert.strictEqual(result.status, 'requested',
          'INVITE_REQUEST_SENT from channels.JoinChannel must produce status=requested');
        assert.strictEqual(result.success, true);
        console.log('OK INVITE_REQUEST_SENT (public channel) -> requested');
      } finally {
        telegramService._resolveEntity = orig;
      }
    }
  );

  // ---- 5. Public path: channels.JoinChannel raises USER_ALREADY_PARTICIPANT -> already_member
  await withStubbedSession(
    SESSION,
    async (req) => {
      const cls = req && req.className;
      if (cls === 'channels.JoinChannel') {
        throw tlError('USER_ALREADY_PARTICIPANT');
      }
      throw new Error(`unexpected call: ${cls}`);
    },
    async () => {
      const orig = telegramService._resolveEntity;
      telegramService._resolveEntity = async () => ({
        className: 'Channel',
        id: BigInt(99),
        accessHash: BigInt(123),
        title: 'Public Channel',
        username: 'public_channel',
      });
      try {
        const result = await telegramService.joinChannel(SESSION, '@public_channel');
        assert.strictEqual(result.status, 'already_member',
          'USER_ALREADY_PARTICIPANT from channels.JoinChannel must collapse to already_member');
        assert.strictEqual(result.skipped, true);
        console.log('OK USER_ALREADY_PARTICIPANT (public channel) -> already_member');
      } finally {
        telegramService._resolveEntity = orig;
      }
    }
  );

  // ---- 6. Happy path: invite-link import succeeds -> joined ----
  await withStubbedSession(
    SESSION,
    async (req) => {
      const cls = req && req.className;
      if (cls === 'messages.CheckChatInvite') {
        return { className: 'ChatInvite', title: 'Open Private Group', requestNeeded: false };
      }
      if (cls === 'messages.ImportChatInvite') {
        return {
          chats: [{ className: 'Channel', id: BigInt(42), title: 'Open Private Group' }],
        };
      }
      throw new Error(`unexpected call: ${cls}`);
    },
    async () => {
      const result = await telegramService.joinChannel(
        SESSION,
        'https://t.me/+openHashAAAAAAAAAA'
      );
      assert.strictEqual(result.status, 'joined');
      assert.strictEqual(result.success, true);
      assert.notStrictEqual(result.skipped, true);
      console.log('OK invite-link happy path -> joined');
    }
  );

  // ---- 7. Happy path: public channel join succeeds -> joined ----
  await withStubbedSession(
    SESSION,
    async (req) => {
      const cls = req && req.className;
      if (cls === 'channels.JoinChannel') {
        return { _updates: [] };
      }
      throw new Error(`unexpected call: ${cls}`);
    },
    async () => {
      const orig = telegramService._resolveEntity;
      telegramService._resolveEntity = async () => ({
        className: 'Channel',
        id: BigInt(7),
        accessHash: BigInt(8),
        title: 'Public Group',
        username: 'public_group',
      });
      try {
        const result = await telegramService.joinChannel(SESSION, '@public_group');
        assert.strictEqual(result.status, 'joined');
        assert.strictEqual(result.success, true);
        console.log('OK public-channel happy path -> joined');
      } finally {
        telegramService._resolveEntity = orig;
      }
    }
  );

  console.log('joinChannelApproval.smoke.test: OK');
})().catch((err) => {
  console.error('joinChannelApproval.smoke.test FAILED:', err);
  process.exit(1);
});
