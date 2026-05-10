/**
 * Smoke test for verify-sessions baseline / compare logic.
 *
 * We can't easily test the DB-querying half of verify-sessions in
 * this harness (it requires a live PG + uploaded session files), but
 * we CAN test the pure functions:
 *
 *   - verifySession() against a synthetic file on disk
 *   - summarize() shape
 *   - compareToBaseline() regression detection
 *
 * Crucially: a session that was OK in the baseline but became
 * unreadable post-deploy MUST be flagged as regressed (this is the
 * single most important property of the script).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const v = require('../../scripts/verify-sessions');

(async () => {
  // ---- verifySession: file missing ----
  let r = await v.verifySession(
    {
      id: 1,
      user_id: 1,
      phone: '+10000000001',
      status: 'active',
      session_file_path: 'nope.json',
      api_id: 12345,
      api_hash: 'abcd',
    },
    () => 'unused'
  );
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /file does not exist/);
  console.log('OK file missing → fail');

  // ---- verifySession: invalid JSON ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-'));
  process.env.UPLOAD_DIR = dir;
  fs.writeFileSync(path.join(dir, 'bad.json'), 'this is not JSON');
  r = await v.verifySession(
    {
      id: 2,
      user_id: 1,
      phone: '+10000000002',
      status: 'active',
      session_file_path: 'bad.json',
      api_id: 12345,
      api_hash: 'abcd',
    },
    () => 'unused'
  );
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /JSON parse failed/);
  console.log('OK invalid JSON → fail');

  // ---- verifySession: missing api credentials ----
  fs.writeFileSync(
    path.join(dir, 'noapi.json'),
    JSON.stringify({ session: 'cipherbytes' })
  );
  r = await v.verifySession(
    {
      id: 3,
      user_id: 1,
      phone: '+1',
      status: 'active',
      session_file_path: 'noapi.json',
      api_id: null,
      api_hash: null,
    },
    () => 'plaintext-12345' // decrypt stub returning a plausible string
  );
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /api_id \/ api_hash missing/);
  console.log('OK missing api credentials → fail');

  // ---- verifySession: happy path ----
  fs.writeFileSync(
    path.join(dir, 'ok.json'),
    JSON.stringify({ session: 'cipherbytes' })
  );
  r = await v.verifySession(
    {
      id: 4,
      user_id: 1,
      phone: '+1',
      status: 'active',
      session_file_path: 'ok.json',
      api_id: 12345,
      api_hash: 'abcd',
    },
    () => 'plaintext-12345' // decrypt stub
  );
  assert.strictEqual(r.ok, true);
  console.log('OK happy path → ok=true');

  // ---- verifySession: decrypt throws ----
  r = await v.verifySession(
    {
      id: 5,
      user_id: 1,
      phone: '+1',
      status: 'active',
      session_file_path: 'ok.json',
      api_id: 12345,
      api_hash: 'abcd',
    },
    () => { throw new Error('bad key'); }
  );
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /decrypt failed/);
  console.log('OK decrypt failure → fail');

  // ---- summarize() ----
  const s = v.summarize([
    { id: 1, ok: true },
    { id: 2, ok: false, phone: '+22', status: 'active', error: 'boom' },
    { id: 3, ok: true },
  ]);
  assert.strictEqual(s.totalChecked, 3);
  assert.strictEqual(s.ok, 2);
  assert.strictEqual(s.failedCount, 1);
  assert.deepStrictEqual(s.failed[0], {
    id: 2, phone: '+22', status: 'active', error: 'boom',
  });
  console.log('OK summarize() shape');

  // ---- compareToBaseline ----
  const baseline = {
    totalChecked: 3,
    ok: 3,
    failed: [],
  };
  // No regressions: same set, all OK
  const cmpOk = v.compareToBaseline(baseline, { ok: 3, failed: [] });
  assert.strictEqual(cmpOk.regressed, false);
  console.log('OK compareToBaseline: no regression on clean run');

  // Regression: a session that was OK is now failed
  const cmpReg = v.compareToBaseline(baseline, {
    ok: 2,
    failed: [{ id: 7, phone: '+1', status: 'active', error: 'file does not exist' }],
  });
  assert.strictEqual(cmpReg.regressed, true);
  assert.strictEqual(cmpReg.newFailures.length, 1);
  console.log('OK compareToBaseline: detects regression');

  // Pre-existing failure does NOT count as regression on the next run
  const baselineFailed = {
    totalChecked: 3,
    ok: 2,
    failed: [{ id: 9, error: 'already broken' }],
  };
  const cmpSame = v.compareToBaseline(baselineFailed, {
    ok: 2,
    failed: [{ id: 9, error: 'still broken' }],
  });
  assert.strictEqual(cmpSame.regressed, false);
  console.log('OK compareToBaseline: pre-existing failure is not a regression');

  // Cleanup
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log('\nverifySessions.smoke.test: OK');
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
