/* eslint-env node */
/* eslint-disable global-require */
'use strict';

/**
 * Smoke tests for the multi-target Instagram scrape upgrade.
 *
 * Verifies — without hitting Instagram or Redis — that:
 *   - parseMediaInput / shortcodeToPk / pkToShortcode round-trip
 *   - paginateMediaLikers / paginateMediaCommenters / paginateUserTags
 *     are exported and yield the expected user shapes when handed a
 *     stub `igFetch` response
 *   - scrapeQuota.consume respects the daily cap when Redis is down
 *
 * Run with: `node test/instagram/scrapeUpgrade.smoke.test.js`
 */

const assert = require('assert');
const path = require('path');

process.chdir(path.join(__dirname, '..', '..'));

let failures = 0;
function ok(name) { console.log(`  PASS  ${name}`); }
function fail(name, err) {
  failures += 1;
  console.error(`  FAIL  ${name}`);
  console.error(err && err.stack ? err.stack : err);
}

async function run(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}

(async () => {
  console.log('IG Scrape Upgrade — smoke');

  // -------------------------------------------------------------------
  // shortcode<->pk pure round-trip
  // -------------------------------------------------------------------
  await run('shortcodeToPk + pkToShortcode round-trip', () => {
    const ws = require('../../src/providers/instagram/webScraper');
    // Real IG shortcodes never start with 'A' because shortcodes are
    // generated from non-zero pks; a leading 'A' would be a leading
    // zero digit in base-64 and is dropped on round-trip.
    const samples = ['CwAU0X4MQQq', 'Ct9vjNfgycS', 'B-A-Z_z-1Aa'];
    for (const sc of samples) {
      const pk = ws.shortcodeToPk(sc);
      const back = ws.pkToShortcode(pk);
      assert.strictEqual(back, sc, `round-trip failed for ${sc} (pk=${pk}, back=${back})`);
    }
  });

  await run('parseMediaInput accepts URLs, shortcodes, and pks', () => {
    const ws = require('../../src/providers/instagram/webScraper');
    const url = ws.parseMediaInput('https://www.instagram.com/p/CwAU0X4MQQq/?igshid=abc');
    assert.strictEqual(url.shortcode, 'CwAU0X4MQQq');
    assert.ok(url.pk && /^\d+$/.test(url.pk));

    const reel = ws.parseMediaInput('https://instagram.com/reel/CwAU0X4MQQq/');
    assert.strictEqual(reel.shortcode, 'CwAU0X4MQQq');

    const sc = ws.parseMediaInput('CwAU0X4MQQq');
    assert.strictEqual(sc.shortcode, 'CwAU0X4MQQq');

    const pk = ws.parseMediaInput('3170625697650639914');
    assert.strictEqual(pk.pk, '3170625697650639914');
    assert.strictEqual(pk.shortcode, 'CwAU0X4MQQq');

    const mobileId = ws.parseMediaInput('3170625697650639914_27291823923');
    assert.strictEqual(mobileId.pk, '3170625697650639914');
  });

  await run('parseMediaInput rejects clearly invalid input', () => {
    const ws = require('../../src/providers/instagram/webScraper');
    assert.throws(() => ws.parseMediaInput(''));
    assert.throws(() => ws.parseMediaInput('!!not-valid!!'));
  });

  // -------------------------------------------------------------------
  // Stub igFetch and exercise the new generators end-to-end.
  // -------------------------------------------------------------------
  await run('paginateMediaLikers yields all users from a single response', async () => {
    // Reset the require cache so we can swap in a stub igFetch and
    // re-require webScraper without polluting other tests.
    delete require.cache[require.resolve('../../src/providers/instagram/webScraper')];
    delete require.cache[require.resolve('../../src/providers/instagram/igFetch')];
    require.cache[require.resolve('../../src/providers/instagram/igFetch')] = {
      id: require.resolve('../../src/providers/instagram/igFetch'),
      filename: require.resolve('../../src/providers/instagram/igFetch'),
      loaded: true,
      exports: {
        igFetch: async () => ({
          users: [
            { pk: 1, username: 'a', full_name: 'A', profile_pic_url: 'x' },
            { pk: 2, username: 'b' },
            { pk: 3, username: 'c' },
          ],
        }),
        sessionContext: async () => ({
          sessionId: 999, cookieHeader: 'sessionid=x', csrftoken: 'y',
          dsUserId: '27291823923', proxyUrl: null, blob: {},
          webFingerprint: { userAgent: 'ua', acceptLanguage: 'en-US,en;q=0.9' },
          locale: { language: 'en_US' }, apiMode: 'web',
        }),
        cookieHeaderFromBlob: () => ({ header: 'sessionid=x', csrftoken: 'y', dsUserId: '0' }),
        pickWebFingerprint: () => ({ userAgent: 'ua', acceptLanguage: 'en-US,en;q=0.9' }),
      },
    };
    const ws = require('../../src/providers/instagram/webScraper');
    const out = [];
    for await (const u of ws.paginateMediaLikers({ id: 999 }, '12345', { limit: 10 })) {
      out.push(u.username);
    }
    assert.deepStrictEqual(out, ['a', 'b', 'c']);
    delete require.cache[require.resolve('../../src/providers/instagram/igFetch')];
    delete require.cache[require.resolve('../../src/providers/instagram/webScraper')];
  });

  await run('paginateMediaCommenters dedupes by user pk', async () => {
    delete require.cache[require.resolve('../../src/providers/instagram/webScraper')];
    delete require.cache[require.resolve('../../src/providers/instagram/igFetch')];
    require.cache[require.resolve('../../src/providers/instagram/igFetch')] = {
      id: require.resolve('../../src/providers/instagram/igFetch'),
      filename: require.resolve('../../src/providers/instagram/igFetch'),
      loaded: true,
      exports: {
        igFetch: async () => ({
          comments: [
            { user: { pk: 1, username: 'alice', full_name: 'A' } },
            { user: { pk: 2, username: 'bob' } },
            // duplicate user — should be dropped
            { user: { pk: 1, username: 'alice', full_name: 'A' } },
          ],
        }),
        sessionContext: async () => ({
          sessionId: 999, cookieHeader: 'sessionid=x', csrftoken: 'y',
          dsUserId: '27291823923', proxyUrl: null, blob: {},
          webFingerprint: { userAgent: 'ua', acceptLanguage: 'en-US,en;q=0.9' },
          locale: { language: 'en_US' }, apiMode: 'web',
        }),
        cookieHeaderFromBlob: () => ({ header: 'sessionid=x', csrftoken: 'y', dsUserId: '0' }),
        pickWebFingerprint: () => ({ userAgent: 'ua', acceptLanguage: 'en-US,en;q=0.9' }),
      },
    };
    const ws = require('../../src/providers/instagram/webScraper');
    const out = [];
    for await (const u of ws.paginateMediaCommenters({ id: 999 }, '12345', { limit: 10 })) {
      out.push(u.username);
    }
    assert.deepStrictEqual(out, ['alice', 'bob']);
    delete require.cache[require.resolve('../../src/providers/instagram/igFetch')];
    delete require.cache[require.resolve('../../src/providers/instagram/webScraper')];
  });

  await run('paginateUserTags yields media owners with shortcode metadata', async () => {
    delete require.cache[require.resolve('../../src/providers/instagram/webScraper')];
    delete require.cache[require.resolve('../../src/providers/instagram/igFetch')];
    require.cache[require.resolve('../../src/providers/instagram/igFetch')] = {
      id: require.resolve('../../src/providers/instagram/igFetch'),
      filename: require.resolve('../../src/providers/instagram/igFetch'),
      loaded: true,
      exports: {
        igFetch: async () => ({
          items: [
            {
              pk: '3170625697650639914',
              code: 'CwAU0X4MQQq',
              user: { pk: 99, username: 'ownerA', full_name: 'Owner A' },
            },
            {
              pk: '3170625697650639915',
              user: { pk: 99, username: 'ownerA' }, // duplicate — should dedupe
            },
            {
              pk: '3170625697650639916',
              code: 'CwAU0X4MQQr',
              user: { pk: 100, username: 'ownerB' },
            },
          ],
          more_available: false,
        }),
        sessionContext: async () => ({
          sessionId: 999, cookieHeader: 'sessionid=x', csrftoken: 'y',
          dsUserId: '27291823923', proxyUrl: null, blob: {},
          webFingerprint: { userAgent: 'ua', acceptLanguage: 'en-US,en;q=0.9' },
          locale: { language: 'en_US' }, apiMode: 'web',
        }),
        cookieHeaderFromBlob: () => ({ header: 'sessionid=x', csrftoken: 'y', dsUserId: '0' }),
        pickWebFingerprint: () => ({ userAgent: 'ua', acceptLanguage: 'en-US,en;q=0.9' }),
      },
    };
    const ws = require('../../src/providers/instagram/webScraper');
    const out = [];
    for await (const u of ws.paginateUserTags({ id: 999 }, '27291823923', { limit: 10, targetUsername: 'xjashan_' })) {
      out.push({ username: u.username, sc: u._media_shortcode });
    }
    assert.deepStrictEqual(out, [
      { username: 'ownerA', sc: 'CwAU0X4MQQq' },
      { username: 'ownerB', sc: 'CwAU0X4MQQr' },
    ]);
    delete require.cache[require.resolve('../../src/providers/instagram/igFetch')];
    delete require.cache[require.resolve('../../src/providers/instagram/webScraper')];
  });

  // -------------------------------------------------------------------
  // scrapeQuota daily cap (Redis-down fallback path).
  // -------------------------------------------------------------------
  await run('scrapeQuota.consume caps at the configured daily limit', async () => {
    // Force the in-memory fallback by simulating a missing redis client.
    const redisMod = require('../../src/config/redis');
    const origReady = redisMod.redisClient && redisMod.redisClient.isReady;
    redisMod.redisClient = { isReady: false };

    // Stub system settings to avoid DB calls.
    const sys = require('../../src/services/systemSettingsService');
    const origGet = sys.getSetting;
    sys.getSetting = async () => 50;

    delete require.cache[require.resolve('../../src/providers/instagram/scrapeQuota')];
    const sq = require('../../src/providers/instagram/scrapeQuota');

    const sid = `test_${Date.now()}_${Math.random()}`;
    const a = await sq.consume(sid, 30);
    assert.strictEqual(a, 30);
    const b = await sq.consume(sid, 30); // would be 60 → only 20 allowed
    assert.strictEqual(b, 20);
    const c = await sq.consume(sid, 5); // already at cap
    assert.strictEqual(c, 0);

    // Restore
    sys.getSetting = origGet;
    if (redisMod.redisClient) redisMod.redisClient.isReady = origReady;
  });

  if (failures === 0) {
    console.log('\nAll scrape-upgrade smoke checks passed.');
    process.exit(0);
  } else {
    console.error(`\n${failures} smoke check(s) FAILED.`);
    process.exit(1);
  }
})();
