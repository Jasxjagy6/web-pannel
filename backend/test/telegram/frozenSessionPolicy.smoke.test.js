/**
 * Frozen-session policy smoke test.
 *
 * Confirmed frozen sessions are blocked by default, but callers explicitly
 * implementing Login, Get OTP, or @SpamBot status handling may opt in. A clean
 * recheck must make the session usable immediately.
 */

'use strict';

const assert = require('assert');
const { pool } = require('../../src/config/database');
const spamStatus = require('../../src/services/sessionSpamStatusService');

const originalQuery = pool.query.bind(pool);
let persistedStatus = 'frozen';
let persistedMessage = null;
let persistedLimitUntil = null;

pool.query = async (sql, params) => {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  if (text.startsWith("SELECT COALESCE(spam_status, 'unknown') AS spam_status")) {
    return { rows: [{ spam_status: persistedStatus }] };
  }
  if (text.startsWith('UPDATE sessions SET spam_status')) {
    persistedStatus = params[1];
    persistedMessage = params[2];
    persistedLimitUntil = params[3];
    return { rowCount: 1, rows: [] };
  }
  if (text.startsWith('SELECT id FROM sessions')) {
    const requested = params[0];
    return {
      rows: requested
        .filter((id) => id !== 91002)
        .map((id) => ({ id })),
    };
  }
  throw new Error(`Unexpected SQL: ${text}`);
};

(async () => {
  try {
    await assert.rejects(
      () => spamStatus.assertUsable(91001),
      (err) => err.code === 'SESSION_FROZEN' && err.statusCode === 423
    );

    // Login, Get OTP, and @SpamBot pass this explicit override. Ordinary
    // callers never receive it.
    await spamStatus.assertUsable(91001, { allowFrozen: true });

    const firstLimitUntil = new Date('2026-08-05T15:22:00.000Z');
    await spamStatus.recordStatus(91001, 'limited', 'Limited until 5 Aug 2026', {
      limitUntil: firstLimitUntil,
    });
    assert.strictEqual(persistedStatus, 'limited');
    assert.strictEqual(persistedLimitUntil.toISOString(), firstLimitUntil.toISOString());
    await spamStatus.assertUsable(91001);

    const updatedLimitUntil = new Date('2026-08-07T11:10:00.000Z');
    await spamStatus.recordStatus(91001, 'limited', 'Limited until 7 Aug 2026', {
      limitUntil: updatedLimitUntil,
    });
    assert.strictEqual(persistedLimitUntil.toISOString(), updatedLimitUntil.toISOString());

    const usable = await spamStatus.filterUsableSessionIds(
      [91001, 91002, 91003],
      { userId: 1, platform: 'telegram' }
    );
    assert.deepStrictEqual(usable, [91001, 91003]);

    await spamStatus.recordStatus(91001, 'clean', 'Good news, no limits are currently applied.');
    assert.strictEqual(persistedStatus, 'clean');
    assert.match(persistedMessage, /no limits/i);
    assert.strictEqual(persistedLimitUntil, null, 'clean recheck must clear the old limit deadline');

    // recordStatus refreshes the cache, so recovery is immediate and does
    // not wait for the five-second DB cache TTL.
    await spamStatus.assertUsable(91001);

    console.log('frozenSessionPolicy.smoke.test: OK');
  } finally {
    pool.query = originalQuery;
  }
})().catch((err) => {
  pool.query = originalQuery;
  console.error(err);
  process.exit(1);
});
