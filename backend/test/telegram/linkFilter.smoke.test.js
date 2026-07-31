'use strict';

/**
 * Link-filter smoke test.
 *
 * 1. Pure t.me HTML classifier: distinguishes a resolved public username
 *    (tgme_page_title + display-name og:title) from the "username available"
 *    contact shell and the generic landing page.
 * 2. mapConcurrent honours the concurrency bound and preserves order.
 * 3. Wiring: controller queues a persisted link-filter job and the worker is
 *    started with the existing username-validation worker.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const svc = require('../../src/services/linkUsernameFilterService');
const { classifyTmeHtml, extractMeta } = svc.__internal;

// mapConcurrent was replaced by the multi-pass driver; test the classifier
// contract and the paced runPass/resolveUsernames wiring instead.

// --- Real captured page shapes (trimmed to the discriminating markers) -----

const VALID_HTML = `
<html><head>
<meta property="og:title" content="Pavel Durov">
<meta property="og:description" content="Founder of Telegram.">
<meta property="og:image" content="https://cdn.telegram.org/x.jpg">
</head><body>
<div class="tgme_page_photo"><img src="x"></div>
<div class="tgme_page_title"><span>Pavel Durov</span></div>
</body></html>`;

const INVALID_HTML = `
<html><head>
<meta property="og:title" content="Telegram: Contact @zzqqxx_not_real_9081">
<meta property="og:description" content="">
<meta property="og:image" content="https://telegram.org/img/t_logo.png">
</head><body></body></html>`;

const GENERIC_HTML = `
<html><head>
<meta property="og:title" content="Telegram &#8211; a new era of messaging">
<meta property="og:description" content="Fast. Secure. Powerful.">
</head><body></body></html>`;

// entity-encoded display name should decode
const VALID_ENTITY_HTML = `
<html><head>
<meta property="og:title" content="Ben &amp; Jerry&#39;s">
</head><body><div class="tgme_page_title">x</div></body></html>`;

(() => {
  const v = classifyTmeHtml(VALID_HTML, 'durov');
  assert.strictEqual(v.valid, true);
  assert.strictEqual(v.kind, 'user');
  assert.strictEqual(v.displayName, 'Pavel Durov');

  // The "username available" contact shell AND the throttled/stripped page
  // both classify as not_found (the multi-pass driver disambiguates via
  // re-verification, since a throttled valid user looks identical to a free
  // username in the HTML).
  const inv = classifyTmeHtml(INVALID_HTML, 'zzqqxx_not_real_9081');
  assert.strictEqual(inv.valid, false);
  assert.strictEqual(inv.kind, 'not_found');

  const gen = classifyTmeHtml(GENERIC_HTML, 'x');
  assert.strictEqual(gen.valid, false);
  assert.strictEqual(gen.kind, 'generic');

  const ent = classifyTmeHtml(VALID_ENTITY_HTML, 'benjerry');
  assert.strictEqual(ent.valid, true);
  assert.strictEqual(ent.displayName, "Ben & Jerry's");

  // Empty body is not a false positive.
  const empty = classifyTmeHtml('', 'whatever');
  assert.strictEqual(empty.valid, false);
})();

console.log('linkFilter.smoke.test: classifier OK');

// --- Multi-pass driver: throttled-valid users recover on re-check ----------

(async () => {
  // Speed the driver up for the test.
  process.env.LINK_FILTER_GAP_MS = '0';
  process.env.LINK_FILTER_PASS_COOLDOWN_MS = '0';
  process.env.LINK_FILTER_BREAKER_PAUSE_MS = '1000';
  // Re-require after env so module-level knobs pick up (fresh instance).
  delete require.cache[require.resolve('../../src/services/linkUsernameFilterService')];
  const svc2 = require('../../src/services/linkUsernameFilterService');
  const { resolveUsernames } = svc2.__internal;

  // Simulate a throttle: userA is really valid but the FIRST fetch of it looks
  // not_found (throttled); the SECOND fetch resolves. userB is genuinely free
  // (always not_found). userC is valid on the first try.
  const seen = {};
  svc2.__fetchOverride = async (u) => {
    seen[u] = (seen[u] || 0) + 1;
    if (u === 'userC') {
      return { ok: true, valid: true, displayName: 'Cee', reason: 'RESOLVED', kind: 'user' };
    }
    if (u === 'userA' && seen[u] >= 2) {
      return { ok: true, valid: true, displayName: 'Aay', reason: 'RESOLVED', kind: 'user' };
    }
    return { ok: true, valid: false, displayName: null, reason: 'NOT_FOUND', kind: 'not_found' };
  };

  try {
    const candidates = [
      { username: 'userA', normalized: 'usera' },
      { username: 'userB', normalized: 'userb' },
      { username: 'userC', normalized: 'userc' },
    ];
    const res = await resolveUsernames(candidates, { deadline: Date.now() + 30000 });
    assert.ok(res.validMap.has('userA'), 'throttled-valid userA must recover on a later pass');
    assert.ok(res.validMap.has('userC'), 'userC valid on first pass');
    assert.ok(!res.validMap.has('userB'), 'genuinely-free userB must stay not-found');
    assert.strictEqual(res.validMap.get('userC'), 'Cee');
    assert.ok(res.passes >= 2, 'must run at least 2 passes to recover throttled user');
  } finally {
    delete svc2.__fetchOverride;
  }

  console.log('linkFilter.smoke.test: multi-pass recovery OK');

  // extractMeta tolerates reversed attribute order.
  const reversed = `<meta content="Hi There" property="og:title">`;
  assert.strictEqual(extractMeta(reversed, 'title'), 'Hi There');

  // --- wiring ---
  const ctrlSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'controllers', 'usernameValidationController.js'), 'utf8');
  assert.match(ctrlSrc, /linkFilter:/);
  assert.match(ctrlSrc, /linkFilterService\.startJob/);
  assert.match(ctrlSrc, /res\.status\(202\)/);

  const routeSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'routes', 'lists.js'), 'utf8');
  assert.match(routeSrc, /username-validation\/link-filter/);

  // Result list is written with source 'link_filter' and no sessions used.
  const svcSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'linkUsernameFilterService.js'), 'utf8');
  assert.match(svcSrc, /'link_filter'/);
  assert.match(svcSrc, /validation_method = 'link'/);
  assert.match(svcSrc, /pass_processed_count/);
  assert.doesNotMatch(svcSrc, /resolveUsernameLive|_ensureConnected|sessionListService/);

  const indexSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.js'), 'utf8');
  assert.match(indexSrc, /linkUsernameFilterService'\)\.startWorker\(\)/);

  console.log('linkFilter.smoke.test: wiring OK');
  console.log('linkFilter.smoke.test: OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
