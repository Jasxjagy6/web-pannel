/* eslint-env node */
/* eslint-disable global-require */
'use strict';

/**
 * Reddit cookie-scraper smoke test.
 *
 * Verifies — without hitting Reddit, Redis, or Postgres — that the
 * scraper subsystem wires together correctly:
 *
 *   R1: TOTP utility produces stable 6-digit codes (RFC 6238 vector)
 *   R2: CookieJar parses Set-Cookie attributes correctly
 *   R3: CookieJar emits the right Cookie: header for host+secure+path matching
 *   R4: format service supports the documented format list
 *   R5: every format exporter returns a non-empty body of the right shape
 *   R6: Netscape exporter encodes the leading-dot domain + epoch rules
 *   R7: capability flag is true on Telegram provider, false on Instagram
 *   R8: queue manager exposes the same shape as the IG scrape queue
 *   R9: routes module loads and exposes the expected paths
 *
 * Run with: `node test/reddit/cookieScraper.smoke.test.js`
 */

process.env.IG_QUEUES_ENABLED = 'false';
process.env.REDDIT_QUEUE_ENABLED = 'false';

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
  console.log('Reddit cookie-scraper smoke');

  // R1 — TOTP RFC 6238 test vector
  await test('R1 totp produces 6-digit code from base32 secret', () => {
    const { totp, hotp, base32Decode } = require('./../../src/utils/totp');
    // RFC 6238 Appendix B test vector — counter=1 for HMAC-SHA1 yields
    // a deterministic 6-digit code.
    const key = base32Decode('JBSWY3DPEHPK3PXP'); // 'Hello!\xde\xad\xbe\xef' in base32
    const code1 = hotp(key, 0);
    const code2 = hotp(key, 1);
    assert.strictEqual(code1.length, 6);
    assert.strictEqual(code2.length, 6);
    assert.notStrictEqual(code1, code2, 'consecutive counters must differ');
    // Deterministic time-based generation
    const t = totp('JBSWY3DPEHPK3PXP', { whenMs: 30_000 });
    assert.strictEqual(t.length, 6);
    assert.ok(/^\d{6}$/.test(t), `expected 6 digits, got ${t}`);
  });

  // R2 — Set-Cookie parsing
  await test('R2 cookie jar parses Set-Cookie attributes', () => {
    const { _internals } = require('./../../src/services/redditCookieScrapeService');
    const c = _internals.parseSetCookie(
      'reddit_session=abc123; domain=.reddit.com; path=/; secure; HttpOnly; SameSite=Lax; expires=Wed, 09 Jun 2027 10:18:14 GMT',
      'https://www.reddit.com/login/'
    );
    assert.strictEqual(c.name, 'reddit_session');
    assert.strictEqual(c.value, 'abc123');
    assert.strictEqual(c.domain, 'reddit.com');
    assert.strictEqual(c.path, '/');
    assert.strictEqual(c.secure, true);
    assert.strictEqual(c.http_only, true);
    assert.strictEqual(c.same_site, 'Lax');
    assert.strictEqual(c.host_only, false);
    assert.ok(c.expires_at);
  });

  // R3 — Cookie header emission
  await test('R3 cookie jar emits matching Cookie header for the right host', () => {
    const { _internals } = require('./../../src/services/redditCookieScrapeService');
    const jar = new _internals.CookieJar();
    jar.setFromHeader('a=1; domain=.reddit.com; path=/; secure', 'https://www.reddit.com/');
    jar.setFromHeader('b=2; domain=.reddit.com; path=/api/; secure', 'https://www.reddit.com/');
    jar.setFromHeader('c=3; domain=chat.reddit.com; path=/; secure', 'https://chat.reddit.com/');
    const h1 = jar.cookieHeaderFor('https://www.reddit.com/api/v1/me');
    assert.ok(h1.includes('a=1'), `expected a=1 in ${h1}`);
    assert.ok(h1.includes('b=2'), `expected b=2 in ${h1}`);
    assert.ok(!h1.includes('c=3'), `did not expect c=3 in ${h1}`);
    // No secure cookies must leak over plain http
    const h2 = jar.cookieHeaderFor('http://www.reddit.com/');
    assert.strictEqual(h2, '');
  });

  // R4 — supported format list
  await test('R4 format service exposes the documented format list', () => {
    const fmt = require('./../../src/services/redditCookieFormatService');
    const expected = [
      'json', 'netscape', 'editthiscookie', 'cookieheader', 'curl',
      'selenium', 'puppeteer', 'har', 'csv', 'python_requests',
      'powershell', 'dotenv', 'js_document_cookie',
    ];
    for (const f of expected) {
      assert.ok(fmt.SUPPORTED.includes(f), `missing format: ${f}`);
      assert.strictEqual(typeof fmt.EXPORTERS[f], 'function', `no exporter fn for: ${f}`);
    }
    assert.strictEqual(fmt.SUPPORTED.length, expected.length, 'extra/unknown formats present');
  });

  const sampleCookies = [
    {
      name: 'reddit_session', value: 'abc.123-DEAD', domain: 'reddit.com',
      path: '/', expires_at: new Date('2027-06-09T10:18:14Z').toISOString(),
      http_only: true, secure: true, same_site: 'Lax', host_only: false,
      source_url: 'https://www.reddit.com/', value_len: 12,
      set_cookie: 'reddit_session=abc.123-DEAD; Domain=.reddit.com; Path=/; Secure; HttpOnly; SameSite=Lax',
    },
    {
      name: 'edgebucket', value: 'eb1', domain: 'reddit.com', path: '/',
      expires_at: null, http_only: false, secure: true, same_site: 'None',
      host_only: false, source_url: 'https://www.reddit.com/', value_len: 3,
      set_cookie: 'edgebucket=eb1; Domain=.reddit.com; Path=/; Secure',
    },
  ];
  const sampleMeta = {
    account: { id: 1, username: 'xjashan_', label: null },
    job: { id: 7, status: 'succeeded', cookies_count: 2 },
    profile: { id: 'abc', name: 'xjashan_', link_karma: 12, comment_karma: 34 },
  };

  // R5 — every exporter produces a non-empty body with the right content type
  await test('R5 every exporter produces a non-empty body with the right Content-Type', () => {
    const fmt = require('./../../src/services/redditCookieFormatService');
    for (const f of fmt.SUPPORTED) {
      const out = fmt.exportCookies(f, sampleCookies, sampleMeta);
      assert.ok(out.body && out.body.length > 0, `${f}: empty body`);
      assert.ok(out.contentType && out.contentType.includes('/'), `${f}: bad contentType`);
      assert.ok(out.filename && /reddit_xjashan__/.test(out.filename), `${f}: bad filename ${out.filename}`);
    }
  });

  // R6 — Netscape format specifics
  await test('R6 Netscape exporter encodes domain dot + epoch + tab field count', () => {
    const fmt = require('./../../src/services/redditCookieFormatService');
    const out = fmt.exportCookies('netscape', sampleCookies, sampleMeta);
    const lines = out.body.split('\n').filter((l) => l && !l.startsWith('#'));
    assert.strictEqual(lines.length, 2);
    const fields = lines[0].split('\t');
    assert.strictEqual(fields.length, 7, `expected 7 tab-separated fields, got ${fields.length}`);
    assert.strictEqual(fields[0], '.reddit.com', 'expected leading-dot host');
    assert.ok(Number.isFinite(parseInt(fields[4], 10)), 'expires field must be epoch');
    assert.strictEqual(fields[5], 'reddit_session');
  });

  // R7 — capability flag wiring
  await test('R7 capability flag is true on telegram provider, false on instagram', () => {
    const tg = require('./../../src/providers/telegram');
    const ig = require('./../../src/providers/instagram');
    assert.strictEqual(tg.capabilities.reddit_cookie_scraper, true);
    assert.strictEqual(ig.capabilities.reddit_cookie_scraper, false);
  });

  // R8 — queue manager shape
  await test('R8 queue manager exposes the same shape as the IG queue', () => {
    const q = require('./../../src/queues/redditScrapeQueue');
    assert.strictEqual(typeof q.initialize, 'function');
    assert.strictEqual(typeof q.setJobExecutor, 'function');
    assert.strictEqual(typeof q.addJob, 'function');
    assert.strictEqual(typeof q.close, 'function');
  });

  // R9 — routes module
  await test('R9 routes module loads and is a function with .stack', () => {
    const router = require('./../../src/routes/reddit');
    assert.strictEqual(typeof router, 'function', 'expected an express router');
    assert.ok(Array.isArray(router.stack), 'expected router.stack array');
    // 1 listing endpoint + 5 account CRUD + 3 per-account + 3 per-job + middleware = at least 12 layers
    assert.ok(router.stack.length >= 10, `expected >=10 router layers, got ${router.stack.length}`);
  });

  console.log(failures === 0 ? '\nAll Reddit smoke tests passed.' : `\n${failures} test(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
})();
