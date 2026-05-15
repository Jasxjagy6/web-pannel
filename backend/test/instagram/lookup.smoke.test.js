/* eslint-env node */
/* eslint-disable global-require */
'use strict';

/**
 * IG lookup module smoke test.
 *
 * Verifies — without hitting Instagram, Redis, or Postgres — that the
 * lookup subsystem wires together correctly:
 *
 *   L1: lookup capability map is wired on the IG provider
 *   L2: lookupLimiter falls back to memory when Redis isn't available
 *   L3: candidateGenerator handles a well-formed email mask
 *   L4: candidateGenerator handles a phone mask with bounded explosion
 *   L5: lookupLimiter ./methods are sane (each method has a runner + capability)
 *   L6: lookup queue manager exposes the same shape as scrape queue
 *   L7: profileInfo input validation rejects obvious junk
 *
 * Run with: `node test/instagram/lookup.smoke.test.js`
 */

const assert = require('assert');
const path = require('path');

process.chdir(path.join(__dirname, '..', '..'));

let failures = 0;
function ok(name) { console.log(`  PASS  ${name}`); }
function fail(name, err) {
  failures += 1;
  console.error(`  FAIL  ${name}: ${err.message}\n${err.stack}`);
}

async function test(name, fn) {
  try { await fn(); ok(name); } catch (err) { fail(name, err); }
}

(async () => {
  console.log('IG lookup smoke');

  await test('L1: lookup capabilities are wired on the IG provider', async () => {
    const provider = require('../../src/providers/instagram');
    assert.ok(provider.capabilities, 'no capabilities map');
    assert.strictEqual(provider.capabilities.lookup_any, true);
    assert.strictEqual(provider.capabilities.lookup_public_profile, true);
    assert.strictEqual(provider.capabilities.lookup_recovery, true);
    assert.strictEqual(provider.capabilities.lookup_cross_platform, true);
    assert.strictEqual(provider.capabilities.lookup_geo, true);
    assert.strictEqual(provider.capabilities.lookup_dork, true);
    // gates that should still be off in this PR
    assert.strictEqual(provider.capabilities.lookup_breach, false);
    assert.strictEqual(provider.capabilities.lookup_email_enumerate, false);
    assert.strictEqual(provider.capabilities.lookup_reverse_image, false);
  });

  await test('L2: lookupLimiter falls back to memory when Redis isn\'t ready', async () => {
    const limiter = require('../../src/providers/instagram/lookup/lookupLimiter');
    const t0 = Date.now();
    const r1 = await limiter.acquire('targetuser', { class: 'read', jitterMs: 0 });
    const r2 = await limiter.acquire('targetuser', { class: 'read', jitterMs: 0 });
    const dt = Date.now() - t0;
    assert.strictEqual(r1.allowed, true);
    assert.strictEqual(r2.allowed, true);
    // Second acquire should have waited ~2s on the read class.
    assert.ok(dt >= 1800, `expected >=1800ms total wait, got ${dt}ms`);
  });

  await test('L3: candidateGenerator handles email mask', async () => {
    const gen = require('../../src/providers/instagram/lookup/candidateGenerator');
    // Mask is "t****a@gmail.com" — first='t', last='a', local len=6
    // Username "tariqa" matches first/last/length → at least one candidate.
    const cands = gen.emailCandidates('t****a@gmail.com', 'tariqa');
    assert.ok(Array.isArray(cands), 'expected array');
    assert.ok(cands.length > 0, `expected at least one candidate, got ${cands.length}`);
    for (const c of cands) {
      assert.strictEqual(typeof c.email, 'string');
      assert.strictEqual(c.email.startsWith('t'), true);
      const local = c.email.split('@')[0];
      assert.strictEqual(local.endsWith('a'), true, `local-part should end with 'a', got ${c.email}`);
      assert.ok(c.email.endsWith('@gmail.com'), `expected gmail.com domain, got ${c.email}`);
      assert.ok(c.confidence > 0 && c.confidence <= 100);
    }
    // A username that doesn't match the mask should produce zero candidates
    // (no false positives).
    const noMatch = gen.emailCandidates('t****a@gmail.com', 'tariqahmed'); // ends with 'd'
    assert.strictEqual(noMatch.length, 0, 'mask non-matching username should produce no candidates');
  });

  await test('L4: candidateGenerator handles phone mask without exploding', async () => {
    const gen = require('../../src/providers/instagram/lookup/candidateGenerator');
    // +1 = US/CA, 10 digits, last 2 known → only 8 unknown digits = too wide
    const tooWide = gen.phoneCandidates('+1 ********47');
    assert.strictEqual(tooWide.length, 1, 'too-wide mask should collapse to a single informational candidate');
    assert.ok(/disabled/.test(tooWide[0].note));
    // Country with last 6 known and 4 unknown → enumerable
    const narrow = gen.phoneCandidates('+1 ****472047');
    assert.ok(narrow.length > 1, 'narrow mask should expand');
    for (const c of narrow.slice(0, 10)) {
      assert.ok(c.phone.startsWith('+1'));
      assert.ok(c.phone.endsWith('472047'));
    }
  });

  await test('L5: lookup methods all have a runner and capability key', async () => {
    const lookup = require('../../src/providers/instagram/lookup');
    assert.ok(lookup.METHODS, 'no METHODS map');
    for (const [code, entry] of Object.entries(lookup.METHODS)) {
      assert.ok(typeof code === 'string' && code.length > 0);
      assert.ok(entry.runner && typeof entry.runner.run === 'function', `method ${code} missing runner`);
      assert.ok(typeof entry.capability === 'string' && entry.capability.startsWith('lookup_'),
        `method ${code} missing lookup_* capability key`);
    }
  });

  await test('L6: lookup queue manager exposes initialise/addJob/setJobExecutor', async () => {
    const q = require('../../src/queues/instagramLookupQueue');
    assert.strictEqual(typeof q.initialize, 'function');
    assert.strictEqual(typeof q.setJobExecutor, 'function');
    assert.strictEqual(typeof q.addJob, 'function');
    assert.strictEqual(q.initialized, false);
  });

  await test('L7: profileInfo rejects junk usernames', async () => {
    const profileInfo = require('../../src/providers/instagram/lookup/profileInfo');
    let threw = false;
    try {
      await profileInfo.run('');
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 400);
    }
    assert.strictEqual(threw, true, 'expected rejection for empty username');
    threw = false;
    try {
      await profileInfo.run('with spaces!');
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 400);
    }
    assert.strictEqual(threw, true, 'expected rejection for invalid username');
  });

  if (failures > 0) {
    console.error(`\nFAILED (${failures} test${failures > 1 ? 's' : ''})`);
    process.exit(1);
  }
  console.log('\nAll lookup smoke tests passed.');
})().catch((err) => {
  console.error('Unhandled in lookup smoke:', err);
  process.exit(1);
});
