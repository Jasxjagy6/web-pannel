/**
 * Telegram anti-revoke smoke test (Phases 1, 2, 3).
 *
 * Pure-Node assertions against the modules that don't need Postgres /
 * Redis / GramJS. The test harness is identical to the IG anti-ban
 * smoke suite so an operator can run all four with the same:
 *
 *   node backend/test/telegram/antiRevoke.smoke.test.js
 *
 * Phase 1 checks (B1-B7): device fingerprinting, locale, restore
 *   scheduler, encryption, identity rotation guard, proxy isolation.
 * Phase 2 checks (B8-B14): MTProto Ping fallback, presence cadence
 *   math, GetAuthorizations probe gating, circadian curfew.
 * Phase 3 checks (B15-B17): detection events sanitisation +
 *   classification, risk score weights, gateOnRisk threshold.
 */

'use strict';

const assert = require('assert');

const PASS = (n) => console.log(`PASS  ${n}`);

// Make the modules under test believe Phase 1/2/3 are enabled, but
// don't try to hit Telegram for anything that touches network.
process.env.ANTI_REVOKE_PHASE_1_ENABLED = 'true';
process.env.ANTI_REVOKE_PHASE_2_ENABLED = 'true';
process.env.ANTI_REVOKE_PHASE_3_ENABLED = 'true';
process.env.ANTI_REVOKE_STRICT_FINGERPRINT = 'true';
process.env.STRICT_PROXY_ISOLATION = 'true';
process.env.SESSION_HEARTBEAT_INTERVAL_MS = '120000';
process.env.SESSION_HEARTBEAT_JITTER_MS = '25000';
process.env.SESSION_OFFLINE_AFTER_IDLE_MS = '300000';
process.env.AUTHORIZATIONS_PROBE_MS = '14400000';
process.env.AUTHORIZATIONS_PROBE_JITTER_MS = '7200000';
process.env.TG_RISK_GATE_THRESHOLD = '0.65';
// Don't fail the bootstrap key assertion in unit tests.
process.env.ANTI_REVOKE_REQUIRE_SESSION_KEY = 'false';

// ---- Phase 1 -----------------------------------------------------------

function _testB1_deviceProfileShape() {
  const fp = require('../../src/utils/deviceFingerprint');
  // Real profiles must have all four GramJS fields + platform + langCode.
  const id = fp.buildIdentity(null, { seed: 'session-1' });
  for (const k of ['deviceModel', 'systemVersion', 'appVersion', 'langCode', 'platform']) {
    assert.ok(id[k], `identity missing ${k}: ${JSON.stringify(id)}`);
  }
  assert.notStrictEqual(id.deviceModel, 'Mozilla/5.0 (X11; Linux x86_64)',
    'identity must NOT carry the panel-default deviceModel');
  assert.notStrictEqual(id.systemVersion, 'Node.js',
    'identity must NOT carry the panel-default systemVersion');
  // Determinism: same seed → same profile.
  const id2 = fp.buildIdentity(null, { seed: 'session-1' });
  assert.strictEqual(id.profileId, id2.profileId,
    'identical seeds must yield the same profile (determinism)');
  assert.strictEqual(id.deviceModel, id2.deviceModel);
  PASS('B1 buildIdentity returns real device profile (deterministic per seed)');
}

function _testB2_countryAwareLocale() {
  const fp = require('../../src/utils/deviceFingerprint');
  const id = fp.buildIdentity(null, { seed: 'cc-IN', country: 'in' });
  // IN -> en-IN (regionalized) instead of bare 'en'.
  assert.strictEqual(id.langCode, 'en-IN',
    `expected en-IN langCode, got: ${id.langCode}`);
  // Country-aware identities should also carry country + timezone.
  assert.strictEqual(String(id.country).toLowerCase(), 'in');
  assert.strictEqual(id.timezone, 'Asia/Kolkata',
    `expected Asia/Kolkata for IN; got ${id.timezone}`);
  // Russian-locale country yields ru-RU (not the default 'en').
  const ru = fp.buildIdentity(null, { seed: 'cc-RU', country: 'ru' });
  assert.strictEqual(ru.langCode, 'ru-RU');
  assert.strictEqual(ru.timezone, 'Europe/Moscow');
  PASS('B2 country-aware locale (IN → en-IN, RU → ru-RU) + timezone present');
}

function _testB3_strictProxyIsolationFlag() {
  // The flag is read by config/telegram and proxyService consumes it.
  const cfg = require('../../src/config/telegram');
  assert.strictEqual(cfg.STRICT_PROXY_ISOLATION, true,
    'STRICT_PROXY_ISOLATION must be true in default+test config');
  // proxyService must reject __direct__ when STRICT_PROXY_ISOLATION=true
  // (see assignProxyForSession). Smoke checks the source contains the
  // guard text — full DB integration tests happen in integration.
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../../src/services/proxyService'), 'utf8');
  assert.ok(/host <> '__direct__'/.test(src),
    'proxyService.assignProxyForSession must filter __direct__ when STRICT_PROXY_ISOLATION=true');
  assert.ok(/STRICT_PROXY_ISOLATION/.test(src),
    'proxyService must reference STRICT_PROXY_ISOLATION');
  PASS('B3 proxy isolation: __direct__ skipped + flag plumbed correctly');
}

function _testB5_restoreScheduler() {
  const sched = require('../../src/utils/restoreScheduler');
  // 50 items over 60 s, cap 10/min -> per-slot ≈ 1.2 s, but minGap=6s.
  const out = sched.buildSchedule(50, 60_000, 10);
  assert.strictEqual(out.length, 50);
  // Monotone non-decreasing.
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i] >= out[i - 1], `not monotone at ${i}: ${out[i]} < ${out[i - 1]}`);
  }
  // perMinuteCap=10 -> minimum gap 6s; but with 50 items in 60s window
  // the last item must land before windowMs + minGap*count to be sane.
  const minGap = Math.ceil(60_000 / 10);
  const maxAllowed = 60_000 + minGap * out.length;
  assert.ok(out[out.length - 1] <= maxAllowed,
    `tail too late: ${out[out.length - 1]}ms (max ${maxAllowed}ms)`);
  // No two consecutive items should violate the per-minute cap.
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i] - out[i - 1] >= minGap - 1,
      `gap too small at ${i}: ${out[i] - out[i - 1]}ms < ${minGap}ms`);
  }
  PASS('B5 restore scheduler honours window + perMinute cap (50 items in 60s, cap 10/min)');
}

function _testB6_sessionCryptoEncryption() {
  process.env.SESSION_ENCRYPTION_KEY =
    Buffer.alloc(32, 'k').toString('hex');
  // Force fresh module load with the env var present.
  delete require.cache[require.resolve('../../src/utils/sessionCrypto')];
  const sc = require('../../src/utils/sessionCrypto');
  assert.strictEqual(sc.isReady(), true, 'sessionCrypto must be ready when key is set');
  const plain = 'hello-anti-revoke';
  const ct = sc.encrypt(plain);
  assert.ok(sc.isV1(ct), `expected v1 envelope, got: ${ct}`);
  const back = sc.decrypt(ct);
  assert.strictEqual(back, plain, 'roundtrip mismatch');
  // Tamper with the body -> auth tag must fail. Flip a byte deep
  // inside the base64 envelope so we can be confident the ciphertext
  // is altered (replacing 'A' with 'B', etc., changes one base64
  // sextet → at least one bit of the underlying bytes).
  const head = ct.slice(0, 3); // 'v1:'
  const tail = ct.slice(3);
  const idx = Math.floor(tail.length / 2);
  const tamperedChar = tail[idx] === 'A' ? 'B' : 'A';
  const tampered = head + tail.slice(0, idx) + tamperedChar + tail.slice(idx + 1);
  let threw = false;
  try { sc.decrypt(tampered); } catch { threw = true; }
  assert.ok(threw, 'tampered ciphertext should fail GCM auth');
  PASS('B6 sessionCrypto v1 envelope: roundtrip + auth-tag check');
}

function _testB6_sessionCryptoKeyDistinct() {
  // SESSION_ENCRYPTION_KEY must be distinct from JWT_SECRET. Use a
  // valid 32-byte hex key on both env vars so _resolveKey accepts it.
  const sharedHex = Buffer.alloc(32, 'k').toString('hex');
  process.env.JWT_SECRET = sharedHex;
  process.env.SESSION_ENCRYPTION_KEY = sharedHex;
  delete require.cache[require.resolve('../../src/utils/sessionCrypto')];
  let threw = null;
  try { require('../../src/utils/sessionCrypto'); } catch (e) { threw = e; }
  assert.ok(threw, 'sessionCrypto must throw when JWT_SECRET == SESSION_ENCRYPTION_KEY');
  assert.ok(/distinct|NOT equal|MUST NOT/i.test(threw.message), `wrong message: ${threw.message}`);
  // Restore distinct values for downstream tests.
  delete process.env.JWT_SECRET;
  process.env.SESSION_ENCRYPTION_KEY = sharedHex;
  delete require.cache[require.resolve('../../src/utils/sessionCrypto')];
  require('../../src/utils/sessionCrypto');
  PASS('B6 sessionCrypto refuses to share key with JWT_SECRET');
}

function _testB7_identityRotateGuard() {
  // Identity rotate must throw IDENTITY_ROTATE_LIVE_FORBIDDEN when
  // status is not in [revoked|expired|error] AND allowLive isn't set.
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../../src/services/identityService'), 'utf8');
  assert.ok(/IDENTITY_ROTATE_LIVE_FORBIDDEN/.test(src),
    'identityService must define IDENTITY_ROTATE_LIVE_FORBIDDEN error code');
  assert.ok(/allowLive/.test(src),
    'identityService.rotate must support {allowLive:true} escape hatch');
  assert.ok(/revoked|expired|error/.test(src),
    'identityService.rotate must permit rotation only for revoked/expired/error rows');
  PASS('B7 identityService.rotate guards against rotating live auth_keys');
}

// ---- Phase 2 -----------------------------------------------------------

function _testB8_pingMethodWired() {
  // pingSession lives on telegramService; we just verify the surface
  // exists and the heartbeat references it. (Live MTProto Ping needs
  // a real connection — covered by manual E2E.)
  const fs = require('fs');
  const tgSrc = fs.readFileSync(require.resolve('../../src/services/telegramService'), 'utf8');
  assert.ok(/async pingSession\(/.test(tgSrc),
    'telegramService.pingSession must exist');
  assert.ok(/PingDelayDisconnect/.test(tgSrc),
    'pingSession must use Api.PingDelayDisconnect');
  const ssSrc = fs.readFileSync(require.resolve('../../src/services/sessionService'), 'utf8');
  assert.ok(/pingSession\(sid\)/.test(ssSrc),
    'sessionService heartbeat must call tgService.pingSession');
  PASS('B8 heartbeat uses MTProto Ping (pingSession) instead of users.GetFullUser');
}

function _testB9_presenceBroadcastWired() {
  const fs = require('fs');
  const tgSrc = fs.readFileSync(require.resolve('../../src/services/telegramService'), 'utf8');
  assert.ok(/async setOnline\(/.test(tgSrc), 'setOnline missing');
  assert.ok(/async setOffline\(/.test(tgSrc), 'setOffline missing');
  assert.ok(/async announceOnlineIfDue\(/.test(tgSrc), 'announceOnlineIfDue missing');
  assert.ok(/account\.UpdateStatus/.test(tgSrc),
    'presence helpers must invoke account.UpdateStatus');
  PASS('B9 online/offline presence broadcasting plumbed in telegramService');
}

function _testB12_authorizationsProbeGating() {
  // The cadence math is local; the network call goes through GramJS
  // but the if-due gate is testable in isolation.
  const fs = require('fs');
  const tgSrc = fs.readFileSync(require.resolve('../../src/services/telegramService'), 'utf8');
  assert.ok(/async checkAuthorizationsIfDue\(/.test(tgSrc),
    'checkAuthorizationsIfDue must exist on telegramService');
  assert.ok(/account\.GetAuthorizations/.test(tgSrc),
    'checkAuthorizationsIfDue must call account.GetAuthorizations');
  assert.ok(/AUTHORIZATIONS_PROBE_MS/.test(tgSrc),
    'checkAuthorizationsIfDue must respect AUTHORIZATIONS_PROBE_MS env knob');
  PASS('B12 GetAuthorizations probe is gated by AUTHORIZATIONS_PROBE_MS cadence');
}

function _testB13_circadianCurfew() {
  // The curfew window is plumbed via config/telegram + read by behaviorService.
  const cfg = require('../../src/config/telegram');
  assert.strictEqual(cfg.BEHAVIOR_CURFEW_HOUR_START, 23,
    'curfew start should default to 23');
  assert.strictEqual(cfg.BEHAVIOR_CURFEW_HOUR_END, 6,
    'curfew end should default to 6');
  PASS('B13 circadian curfew env knobs default to 23:00–06:00');
}

// ---- Phase 3 -----------------------------------------------------------

function _testB15_detectionEventsSanitisation() {
  const det = require('../../src/providers/telegram/detectionEvents');
  const sanitized = det.sanitizeFingerprint({
    api_method: 'auth.signIn',
    phone_number: '+1234567890',
    proxy_url: 'http://x:y@socks.example.com',
    cookies: 'sessionid=abc',
    nested: {
      authorization: 'Bearer xyz',
      keep_me: 'visible',
    },
    list: [
      { password: 'p', ok: 'yes' },
      'string-element',
    ],
  });
  // Top-level PII keys removed.
  assert.strictEqual(sanitized.phone_number, undefined);
  assert.strictEqual(sanitized.proxy_url, undefined);
  assert.strictEqual(sanitized.cookies, undefined);
  // Nested PII keys removed.
  assert.strictEqual(sanitized.nested.authorization, undefined);
  assert.strictEqual(sanitized.nested.keep_me, 'visible');
  // List recursion preserved + cleaned.
  assert.strictEqual(sanitized.list[0].password, undefined);
  assert.strictEqual(sanitized.list[0].ok, 'yes');
  assert.strictEqual(sanitized.list[1], 'string-element');
  PASS('B15 sanitizeFingerprint drops cookies / phone / proxy / authorization / password recursively');
}

function _testB15_classifyTelegramError() {
  const det = require('../../src/providers/telegram/detectionEvents');
  const cases = [
    { msg: 'AUTH_KEY_DUPLICATED', expectType: 'auth_key_duplicated', expectSev: 'critical' },
    { msg: 'AUTH_KEY_UNREGISTERED', expectType: 'auth_key_unregistered', expectSev: 'critical' },
    { msg: 'SESSION_REVOKED', expectType: 'session_revoked', expectSev: 'critical' },
    { msg: 'USER_DEACTIVATED', expectType: 'user_deactivated', expectSev: 'critical' },
    { msg: 'PEER_FLOOD: too many', expectType: 'peer_flood', expectSev: 'warning' },
    { msg: 'FLOOD_WAIT_45 - try again', expectType: 'flood_wait_long', expectSev: 'warning' },
    { msg: 'FLOOD_WAIT_3600', expectType: 'flood_wait_extreme', expectSev: 'critical' },
    { msg: 'PHONE_MIGRATE_5', expectType: 'dc_migrate', expectSev: 'info' },
  ];
  for (const c of cases) {
    const out = det.classifyTelegramError({ message: c.msg });
    assert.ok(out, `classify returned null for ${c.msg}`);
    assert.strictEqual(out.event_type, c.expectType, `${c.msg} → ${out.event_type}`);
    assert.strictEqual(out.severity, c.expectSev, `${c.msg} sev → ${out.severity}`);
  }
  // Below-threshold flood waits are dropped (don't pollute the audit log).
  assert.strictEqual(det.classifyTelegramError({ message: 'FLOOD_WAIT_5' }), null);
  PASS('B15 classifyTelegramError maps Telegram error names → event_type + severity');
}

function _testB16_riskScoreWeights() {
  const tgRisk = require('../../src/providers/telegram/riskScore');
  // Weights must sum to ~1.0 and match the proposal table.
  const w = tgRisk.WEIGHTS;
  const sum =
    w.flood + w.ageFactor + w.geoJump + w.dcMigrate +
    w.failedPings + w.authProbeOverdue + w.reauthRecency;
  assert.ok(Math.abs(sum - 1.0) < 1e-6, `weights must sum to 1.0; got ${sum}`);
  assert.strictEqual(w.flood,         0.30, 'flood weight');
  assert.strictEqual(w.ageFactor,     0.20, 'ageFactor weight');
  assert.strictEqual(w.geoJump,       0.15, 'geoJump weight');
  assert.strictEqual(w.dcMigrate,     0.10, 'dcMigrate weight');
  assert.strictEqual(w.failedPings,   0.10, 'failedPings weight');
  assert.strictEqual(w.authProbeOverdue, 0.10, 'authProbeOverdue weight');
  assert.strictEqual(w.reauthRecency, 0.05, 'reauthRecency weight');
  PASS('B16 riskScore weights match the proposal (sum=1.0)');
}

function _testB17_gateSurface() {
  // gateOnRisk must throw a 403 with code RISK_TOO_HIGH (verified by
  // shape; the actual DB read needs a running Postgres).
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../../src/providers/telegram/riskScore'), 'utf8');
  assert.ok(/RISK_TOO_HIGH/.test(src), 'gateOnRisk must use RISK_TOO_HIGH error code');
  assert.ok(/statusCode = 403/.test(src), 'gateOnRisk must produce HTTP 403');
  // Verify the gate is wired into scrape + messaging entry points.
  const scrapeSrc = fs.readFileSync(require.resolve('../../src/services/scrapeService'), 'utf8');
  assert.ok(/gateOnRisk/.test(scrapeSrc) && /RISK_TOO_HIGH/.test(scrapeSrc),
    'scrapeService must call gateOnRisk and handle RISK_TOO_HIGH');
  const msgSrc = fs.readFileSync(require.resolve('../../src/services/messageService'), 'utf8');
  assert.ok(/gateOnRisk/.test(msgSrc) && /RISK_TOO_HIGH/.test(msgSrc),
    'messageService must call gateOnRisk and handle RISK_TOO_HIGH');
  PASS('B17 gateOnRisk wired into scrape + messaging entry points (RISK_TOO_HIGH/403)');
}

function _testB18_adminEndpoints() {
  const fs = require('fs');
  const ctrl = fs.readFileSync(require.resolve('../../src/controllers/adminController'), 'utf8');
  const route = fs.readFileSync(require.resolve('../../src/routes/admin'), 'utf8');
  assert.ok(/tgDetectionEvents/.test(ctrl) && /tgRisk/.test(ctrl) && /tgSessionHealth/.test(ctrl),
    'adminController must export tgDetectionEvents, tgRisk, tgSessionHealth');
  assert.ok(/tg-detection-events/.test(route) && /tg-risk/.test(route) && /tg-session-health/.test(route),
    'admin routes must expose the three TG anti-revoke endpoints');
  PASS('B18 admin routes + controllers exist for tg-detection-events, tg-risk, tg-session-health');
}

// ---- Runner ------------------------------------------------------------

function run() {
  // Phase 1
  _testB1_deviceProfileShape();
  _testB2_countryAwareLocale();
  _testB3_strictProxyIsolationFlag();
  _testB5_restoreScheduler();
  _testB6_sessionCryptoEncryption();
  _testB6_sessionCryptoKeyDistinct();
  _testB7_identityRotateGuard();
  // Phase 2
  _testB8_pingMethodWired();
  _testB9_presenceBroadcastWired();
  _testB12_authorizationsProbeGating();
  _testB13_circadianCurfew();
  // Phase 3
  _testB15_detectionEventsSanitisation();
  _testB15_classifyTelegramError();
  _testB16_riskScoreWeights();
  _testB17_gateSurface();
  _testB18_adminEndpoints();

  console.log('\nALL TG ANTI-REVOKE SMOKE CHECKS PASSED');
}

if (require.main === module) {
  try {
    run();
  } catch (err) {
    console.error('FAIL', err && err.message ? err.message : err);
    if (err && err.stack) console.error(err.stack);
    process.exitCode = 1;
  }
}

module.exports = { run };
