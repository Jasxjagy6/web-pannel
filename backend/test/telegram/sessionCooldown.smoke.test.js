/**
 * Smoke test for sessionCooldown.
 *
 * Pins down the behavioural contract operators rely on:
 *
 *   1. `markFloodCooldown(...)` with a real Telegram-supplied duration
 *      writes the cooldown row.
 *   2. `markFloodCooldown(...)` with `null` / `0` / negative / NaN seconds
 *      is a NO-OP — we used to silently fall back to a hardcoded 6h
 *      default, which produced bogus "5h remaining" badges across every
 *      session that ever hit PEER_FLOOD.
 *   3. `markPeerFlood(...)` is a no-op by default (PEER_FLOOD does not
 *      carry a duration; `PEER_FLOOD_COOLDOWN_SECONDS=0` is the default).
 *   4. `markPeerFlood(...)` honours `PEER_FLOOD_COOLDOWN_SECONDS` when an
 *      operator opts back into the legacy safety lockout.
 *   5. Sub-threshold (< 30s) flood waits are dropped (existing behaviour).
 *
 * Pure unit test — stubs the pg pool's `query` method so we never touch
 * a real database.
 */

'use strict';

const assert = require('assert');
const path = require('path');

function freshLoad() {
  // Drop any cached modules so each scenario observes the env var as set
  // at require-time (the PEER_FLOOD default is computed once at module
  // load, which is exactly what the production process does).
  const cooldownPath = require.resolve('../../src/services/sessionCooldown');
  const databasePath = require.resolve('../../src/config/database');
  delete require.cache[cooldownPath];
  delete require.cache[databasePath];
  const { pool } = require('../../src/config/database');
  const calls = [];
  pool.query = async (text, params) => {
    calls.push({ text: String(text), params });
    return { rows: [], rowCount: 0 };
  };
  const sessionCooldown = require('../../src/services/sessionCooldown');
  return { sessionCooldown, calls };
}

(async () => {
  // 1. FLOOD_WAIT with a real duration writes a row.
  {
    delete process.env.PEER_FLOOD_COOLDOWN_SECONDS;
    const { sessionCooldown, calls } = freshLoad();
    await sessionCooldown.markFloodCooldown(42, 120, 'FLOOD_WAIT_120');
    assert.strictEqual(calls.length, 1, 'expected one UPDATE for a real FLOOD_WAIT');
    assert.ok(/UPDATE sessions/.test(calls[0].text), 'expected sessions UPDATE');
    assert.deepStrictEqual(calls[0].params, ['42', 120, 'FLOOD_WAIT_120']);
    console.log('OK markFloodCooldown writes for real FLOOD_WAIT_N');
  }

  // 2. markFloodCooldown is a NO-OP for invalid / non-positive seconds.
  //    This is the core regression fix — used to silently default to 6h.
  {
    delete process.env.PEER_FLOOD_COOLDOWN_SECONDS;
    const { sessionCooldown, calls } = freshLoad();
    await sessionCooldown.markFloodCooldown(42, 0, 'X');
    await sessionCooldown.markFloodCooldown(42, -10, 'X');
    await sessionCooldown.markFloodCooldown(42, null, 'X');
    await sessionCooldown.markFloodCooldown(42, undefined, 'X');
    await sessionCooldown.markFloodCooldown(42, Number.NaN, 'X');
    await sessionCooldown.markFloodCooldown(42, 'banana', 'X');
    assert.strictEqual(
      calls.length,
      0,
      `expected zero writes for invalid durations, got ${calls.length}`
    );
    console.log('OK markFloodCooldown no-ops on invalid/zero/negative seconds');
  }

  // 3. Sub-threshold FLOOD_WAITs (< 30s) are dropped on the floor — too
  //    small to be worth a panel lockout.
  {
    delete process.env.PEER_FLOOD_COOLDOWN_SECONDS;
    const { sessionCooldown, calls } = freshLoad();
    await sessionCooldown.markFloodCooldown(42, 5, 'FLOOD_WAIT_5');
    await sessionCooldown.markFloodCooldown(42, 29, 'FLOOD_WAIT_29');
    assert.strictEqual(calls.length, 0, 'sub-threshold waits should be dropped');
    console.log('OK markFloodCooldown drops sub-threshold (<30s) waits');
  }

  // 4. markPeerFlood is a NO-OP by default (PEER_FLOOD has no duration).
  //    This is the user-visible fix: PEER_FLOOD no longer silently
  //    locks a session out for a hardcoded 6h panel value.
  {
    delete process.env.PEER_FLOOD_COOLDOWN_SECONDS;
    const { sessionCooldown, calls } = freshLoad();
    await sessionCooldown.markPeerFlood('99', 'PEER_FLOOD');
    assert.strictEqual(
      calls.length,
      0,
      `expected zero writes for PEER_FLOOD with default env, got ${calls.length}`
    );
    console.log('OK markPeerFlood is no-op by default (default env)');
  }

  // 5. Empty-string env is treated as unset → no-op.
  {
    process.env.PEER_FLOOD_COOLDOWN_SECONDS = '';
    const { sessionCooldown, calls } = freshLoad();
    await sessionCooldown.markPeerFlood('99', 'PEER_FLOOD');
    assert.strictEqual(calls.length, 0);
    console.log('OK markPeerFlood no-op when PEER_FLOOD_COOLDOWN_SECONDS=""');
  }

  // 6. Zero env is no-op.
  {
    process.env.PEER_FLOOD_COOLDOWN_SECONDS = '0';
    const { sessionCooldown, calls } = freshLoad();
    await sessionCooldown.markPeerFlood('99', 'PEER_FLOOD');
    assert.strictEqual(calls.length, 0);
    console.log('OK markPeerFlood no-op when PEER_FLOOD_COOLDOWN_SECONDS=0');
  }

  // 7. Garbage env is no-op (parse failure → 0).
  {
    process.env.PEER_FLOOD_COOLDOWN_SECONDS = 'not-a-number';
    const { sessionCooldown, calls } = freshLoad();
    await sessionCooldown.markPeerFlood('99', 'PEER_FLOOD');
    assert.strictEqual(calls.length, 0);
    console.log('OK markPeerFlood no-op when env is garbage');
  }

  // 8. Negative env is no-op (clamped to 0).
  {
    process.env.PEER_FLOOD_COOLDOWN_SECONDS = '-60';
    const { sessionCooldown, calls } = freshLoad();
    await sessionCooldown.markPeerFlood('99', 'PEER_FLOOD');
    assert.strictEqual(calls.length, 0);
    console.log('OK markPeerFlood no-op when env is negative');
  }

  // 9. Operator opt-in: PEER_FLOOD_COOLDOWN_SECONDS=3600 writes 3600s.
  {
    process.env.PEER_FLOOD_COOLDOWN_SECONDS = '3600';
    const { sessionCooldown, calls } = freshLoad();
    await sessionCooldown.markPeerFlood('99', 'PEER_FLOOD');
    assert.strictEqual(calls.length, 1, 'expected one write for opt-in PEER_FLOOD');
    assert.deepStrictEqual(calls[0].params, ['99', 3600, 'PEER_FLOOD']);
    console.log('OK markPeerFlood honours PEER_FLOOD_COOLDOWN_SECONDS opt-in');
  }

  // 10. Operator opt-in clamped to MAX_COOLDOWN_SECONDS (7 days).
  {
    const SEVEN_DAYS = 7 * 24 * 60 * 60;
    process.env.PEER_FLOOD_COOLDOWN_SECONDS = String(SEVEN_DAYS * 5);
    const { sessionCooldown, calls } = freshLoad();
    await sessionCooldown.markPeerFlood('99', 'PEER_FLOOD');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].params[1], SEVEN_DAYS, 'opt-in clamped to 7d');
    console.log('OK markPeerFlood opt-in clamped to MAX_COOLDOWN_SECONDS');
  }

  // 11. Constants exported.
  {
    delete process.env.PEER_FLOOD_COOLDOWN_SECONDS;
    const { sessionCooldown } = freshLoad();
    assert.strictEqual(sessionCooldown.DEFAULT_PEER_FLOOD_SECONDS, 0);
    assert.strictEqual(sessionCooldown.MIN_RECORDED_FLOOD_SECONDS, 30);
    console.log('OK DEFAULT_PEER_FLOOD_SECONDS defaults to 0');
  }

  // 12. Constants reflect env at module-load time.
  {
    process.env.PEER_FLOOD_COOLDOWN_SECONDS = '12345';
    const { sessionCooldown } = freshLoad();
    assert.strictEqual(sessionCooldown.DEFAULT_PEER_FLOOD_SECONDS, 12345);
    console.log('OK DEFAULT_PEER_FLOOD_SECONDS reflects env at load');
  }

  console.log('\nALL sessionCooldown smoke tests passed.');
  // Force-exit so the pg Pool doesn't keep the event loop alive.
  setImmediate(() => process.exit(0));
})().catch((err) => {
  console.error('sessionCooldown smoke test FAILED:', err);
  process.exit(1);
});
