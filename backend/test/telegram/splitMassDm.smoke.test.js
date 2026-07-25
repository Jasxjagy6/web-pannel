'use strict';

/**
 * Split-mass-DM smoke test.
 *
 * 1. Pure splitter (computeSplitAssignments): contiguous, non-overlapping,
 *    order-preserving slices; quota auto-scales so no verified target is
 *    dropped; small audiences leave trailing sessions idle.
 * 2. Runner wiring: the split runner sends each session ONLY its own slice,
 *    all slices run simultaneously, and a limited session stops just its slice
 *    (its remaining users are skipped, not reassigned).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { pool } = require('../../src/config/database');
const telegramService = require('../../src/services/telegramService');
const messageService = require('../../src/services/messageService');

const { computeSplitAssignments } = messageService.__internal;

// --- 1. Pure splitter ------------------------------------------------------

// Canonical example from the operator: 1000 users, 100 sessions, quota 10.
(() => {
  const { effectiveQuota, slices } = computeSplitAssignments(1000, 100, 10);
  assert.strictEqual(effectiveQuota, 10);
  assert.strictEqual(slices.length, 100);
  assert.strictEqual(slices[0].start, 0);
  assert.strictEqual(slices[0].end, 10);
  assert.strictEqual(slices[1].start, 10);
  assert.strictEqual(slices[1].end, 20);
  assert.strictEqual(slices[99].start, 990);
  assert.strictEqual(slices[99].end, 1000);
  // Full coverage exactly once.
  const covered = slices.reduce((n, s) => n + s.count, 0);
  assert.strictEqual(covered, 1000);
})();

// Audience larger than sessions*quota -> quota auto-bumps so nothing dropped.
(() => {
  const { effectiveQuota, slices } = computeSplitAssignments(1500, 100, 10);
  assert.strictEqual(effectiveQuota, 15, 'quota must bump to cover all users');
  const covered = slices.reduce((n, s) => n + s.count, 0);
  assert.strictEqual(covered, 1500);
  // Contiguous & non-overlapping.
  for (let i = 1; i < slices.length; i++) {
    assert.strictEqual(slices[i].start, slices[i - 1].end);
  }
})();

// Audience smaller than sessions*quota -> trailing sessions idle, order kept.
(() => {
  const { effectiveQuota, slices } = computeSplitAssignments(25, 10, 10);
  assert.strictEqual(effectiveQuota, 10);
  assert.strictEqual(slices[0].count, 10);
  assert.strictEqual(slices[1].count, 10);
  assert.strictEqual(slices[2].count, 5);
  assert.strictEqual(slices[3].count, 0, 'trailing sessions get empty slices');
  assert.strictEqual(slices.filter((s) => s.count > 0).length, 3);
  const covered = slices.reduce((n, s) => n + s.count, 0);
  assert.strictEqual(covered, 25);
})();

// Uneven remainder still covers everything (7 users, 3 sessions, quota 2 ->
// bumps to 3).
(() => {
  const { effectiveQuota, slices } = computeSplitAssignments(7, 3, 2);
  assert.strictEqual(effectiveQuota, 3);
  assert.deepStrictEqual(slices.map((s) => s.count), [3, 3, 1]);
})();

console.log('splitMassDm.smoke.test: splitter OK');

// --- 2. Runner wiring ------------------------------------------------------

const origQuery = pool.query.bind(pool);
const origSend = telegramService.sendMessage;

(async () => {
  try {
    // 30 targets, 3 sessions, quota 10 -> session i owns targets [10i,10i+10).
    const targets = Array.from({ length: 30 }, (_, i) => ({
      addr: `@user${i}`, peerId: null, label: `@user${i}`, accessHash: null,
    }));
    const { slices } = computeSplitAssignments(30, 3, 10);
    const sessionIds = ['201', '202', '203'];

    // Record which session sent which target + concurrency proof.
    const sentBySession = { 201: [], 202: [], 203: [] };
    let inFlight = 0;
    let maxInFlight = 0;

    pool.query = async () => ({ rows: [], rowCount: 0 });

    telegramService.sendMessage = async (sid, addr) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      // Session 202 gets limited on its 3rd send (index 12).
      if (String(sid) === '202' && addr === '@user12') {
        inFlight--;
        const err = new Error('PEER_FLOOD');
        err.code = 'PEER_FLOOD';
        throw err;
      }
      sentBySession[String(sid)].push(addr);
      inFlight--;
      return { messageId: 1 };
    };

    const result = await messageService._runSplitMassDm(
      9100, sessionIds, targets, slices,
      { message: 'hi', messageType: 'text', delayMin: 0, delayMax: 0, messageOptions: {} }
    );

    // Session 201 sent its full slice [0,10).
    assert.deepStrictEqual(
      sentBySession['201'],
      targets.slice(0, 10).map((t) => t.addr),
      'session 201 must send exactly its own contiguous slice'
    );
    // Session 203 sent its full slice [20,30).
    assert.deepStrictEqual(
      sentBySession['203'],
      targets.slice(20, 30).map((t) => t.addr),
      'session 203 must send exactly its own contiguous slice'
    );
    // Session 202 stopped at @user12 (sent 10,11 only), rest of ITS slice skipped.
    assert.deepStrictEqual(sentBySession['202'], ['@user10', '@user11']);

    // No session ever touched another session's slice.
    for (const addr of sentBySession['201']) {
      assert.ok(!sentBySession['202'].includes(addr) && !sentBySession['203'].includes(addr));
    }

    // Counts: 10 (s201) + 2 (s202) + 10 (s203) = 22 sent; 8 remaining in s202
    // slice skipped; 0 failed.
    assert.strictEqual(result.sent, 22, `expected 22 sent, got ${result.sent}`);
    assert.strictEqual(result.skipped, 8, `expected 8 skipped, got ${result.skipped}`);
    assert.strictEqual(result.failed, 0);

    // Simultaneity: all 3 slices ran at once (limited session doesn't serialize
    // the others).
    assert.ok(maxInFlight >= 3, `slices must run simultaneously (maxInFlight=${maxInFlight})`);

    console.log('splitMassDm.smoke.test: runner OK');

    // --- 3. Wiring assertions (route/queue/controller/validator) -----------
    const routeSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'routes', 'messages.js'), 'utf8');
    assert.match(routeSrc, /router\.post\('\/split',[^\n]*messageController\.sendSplit\)/);

    const queueSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'queues', 'messageQueue.js'), 'utf8');
    assert.match(queueSrc, /type === 'split'/);
    assert.match(queueSrc, /sendSplitMassDm\(params, userId\)/);

    const ctrlSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'controllers', 'messageController.js'), 'utf8');
    assert.match(ctrlSrc, /sendSplit:/);
    assert.match(ctrlSrc, /filterBulkDmSessionIds\(sessionIds, userId\)/);
    assert.match(ctrlSrc, /messageQueue\.addJob\(\{ type: 'split'/);

    const validatorSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'middleware', 'validator.js'), 'utf8');
    assert.match(validatorSrc, /dmsPerSession: Joi\.number/);

    // Split runner uses the mass-DM eligibility filter (Limited allowed only
    // when expired; Frozen excluded) — same contract as parallel.
    const svcSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'messageService.js'), 'utf8');
    const splitMethod = svcSrc.slice(
      svcSrc.indexOf('async sendSplitMassDm('),
      svcSrc.indexOf('async _runSplitMassDm(')
    );
    assert.match(splitMethod, /excludeLimited:\s*true/);

    console.log('splitMassDm.smoke.test: wiring OK');
    console.log('splitMassDm.smoke.test: OK');
  } finally {
    pool.query = origQuery;
    telegramService.sendMessage = origSend;
  }
})().catch((err) => {
  pool.query = origQuery;
  telegramService.sendMessage = origSend;
  console.error(err);
  process.exit(1);
});
