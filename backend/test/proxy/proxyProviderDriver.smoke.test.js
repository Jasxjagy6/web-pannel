/* eslint-disable no-console */
/**
 * Smoke tests for the rotating-proxy provider drivers.
 *
 * Locks in the gateway+suffix contract for IPRoyal / SOAX /
 * ProxyEmpire / Smartproxy / custom: each driver should produce a
 * unique sticky session token on every call and a username string
 * laid out the way the upstream gateway expects.
 *
 * No network calls; we only exercise the pure driver methods.
 */

const path = require('path');
const driversDir = path.join(__dirname, '..', '..', 'src', 'services', 'proxyProviders');
const IPRoyalDriver = require(path.join(driversDir, 'iproyalDriver'));
const SoaxDriver = require(path.join(driversDir, 'soaxDriver'));
const ProxyEmpireDriver = require(path.join(driversDir, 'proxyEmpireDriver'));
const SmartproxyDriver = require(path.join(driversDir, 'smartproxyDriver'));
const CustomEndpointDriver = require(path.join(driversDir, 'customEndpointDriver'));
const registry = require(path.join(driversDir, 'index'));

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) { console.log(name, 'OK'); pass++; }
  else { console.error(name, 'FAIL', detail || ''); fail++; }
}

function makeProvider(extra = {}) {
  return {
    id: 1,
    user_id: 9,
    vendor: extra.vendor || 'iproyal',
    label: 'test-provider',
    endpoint_host: 'geo.example.com',
    endpoint_port: 12321,
    endpoint_protocol: 'http',
    country_code: extra.country_code === undefined ? 'us' : extra.country_code,
    sticky_lifetime_minutes: extra.sticky_lifetime_minutes || 30,
    rotation_policy: 'per_session',
    _apiExtraDecoded: extra._apiExtraDecoded || null,
    ...extra,
  };
}

function makeDecoded(extra = {}) {
  return {
    endpoint_username: 'baseuser',
    endpoint_password: 'basepass',
    api_key: null,
    api_extra: null,
    ...extra,
  };
}

async function testIPRoyalProvision() {
  const drv = new IPRoyalDriver();
  const provider = makeProvider({ vendor: 'iproyal', country_code: 'us' });
  const decoded = makeDecoded();
  const a = await drv.provisionForSession(provider, decoded, { sessionId: 1 });
  const b = await drv.provisionForSession(provider, decoded, { sessionId: 2 });
  ok('iproyal.distinctTokens',
    a.sticky_session_token !== b.sticky_session_token,
    `${a.sticky_session_token} === ${b.sticky_session_token}`);
  ok('iproyal.usernameSuffix',
    /^baseuser_country-us_session-[a-f0-9]{8}_lifetime-30m$/.test(a.username),
    a.username);
  ok('iproyal.expiresIn30',
    a.sticky_expires_at - new Date() <= 30 * 60_000 + 1500
    && a.sticky_expires_at - new Date() >= 30 * 60_000 - 1500,
    a.sticky_expires_at);
  ok('iproyal.host', a.host === 'geo.example.com', a.host);
  ok('iproyal.password', a.password === 'basepass', a.password);
}

async function testIPRoyalNoCountry() {
  const drv = new IPRoyalDriver();
  const provider = makeProvider({ vendor: 'iproyal', country_code: '' });
  const decoded = makeDecoded();
  const a = await drv.provisionForSession(provider, decoded, { sessionId: 1 });
  ok('iproyal.noCountrySuffix',
    /^baseuser_session-[a-f0-9]{8}_lifetime-30m$/.test(a.username),
    a.username);
}

async function testIPRoyalRotate() {
  const drv = new IPRoyalDriver();
  const provider = makeProvider({ vendor: 'iproyal' });
  const decoded = makeDecoded();
  const a = await drv.provisionForSession(provider, decoded, { sessionId: 1 });
  const b = await drv.rotate(provider, decoded, a);
  ok('iproyal.rotate.distinctToken',
    a.sticky_session_token !== b.sticky_session_token,
    `${a.sticky_session_token} === ${b.sticky_session_token}`);
}

async function testSoaxProvision() {
  const drv = new SoaxDriver();
  const provider = makeProvider({
    vendor: 'soax',
    country_code: 'gb',
    sticky_lifetime_minutes: 10,
    _apiExtraDecoded: { package_id: 42 },
  });
  const decoded = makeDecoded();
  const a = await drv.provisionForSession(provider, decoded, { sessionId: 1 });
  ok('soax.usernameSuffix',
    /^baseuser-package-42-country-gb-sessionid-[a-f0-9]{8}-sessionlength-600$/.test(a.username),
    a.username);
}

async function testProxyEmpireProvision() {
  const drv = new ProxyEmpireDriver();
  const provider = makeProvider({ vendor: 'proxyempire', country_code: 'fr' });
  const decoded = makeDecoded();
  const a = await drv.provisionForSession(provider, decoded, { sessionId: 1 });
  ok('proxyempire.usernameSuffix',
    /^baseuser-country-fr-session-[a-f0-9]{8}-lifetime-30m$/.test(a.username),
    a.username);
}

async function testSmartproxyProvision() {
  const drv = new SmartproxyDriver();
  const provider = makeProvider({ vendor: 'smartproxy', country_code: 'us' });
  const decoded = makeDecoded();
  const a = await drv.provisionForSession(provider, decoded, { sessionId: 1 });
  ok('smartproxy.usernameSuffix',
    /^baseuser-country-us-session-[a-f0-9]{8}-sessionduration-30$/.test(a.username),
    a.username);
}

async function testCustomTemplate() {
  const drv = new CustomEndpointDriver();
  const provider = makeProvider({
    vendor: 'custom',
    country_code: 'in',
    sticky_lifetime_minutes: 15,
    _apiExtraDecoded: {
      suffix_template: 'session-{token}_country-{country}_lifetime-{minutes}m',
      suffix_join: ':',
    },
  });
  const decoded = makeDecoded();
  const a = await drv.provisionForSession(provider, decoded, { sessionId: 1 });
  ok('custom.usernameSuffix',
    /^baseuser:session-[a-f0-9]{8}_country-in_lifetime-15m$/.test(a.username),
    a.username);
}

async function testCustomEmptyCountryCollapses() {
  const drv = new CustomEndpointDriver();
  const provider = makeProvider({
    vendor: 'custom',
    country_code: '',
    _apiExtraDecoded: {
      suffix_template: 'country-{country}_session-{token}_lifetime-{minutes}m',
    },
  });
  const decoded = makeDecoded();
  const a = await drv.provisionForSession(provider, decoded, { sessionId: 1 });
  ok('custom.collapseCountry',
    /^baseuser_session-[a-f0-9]{8}_lifetime-30m$/.test(a.username) ||
    /^baseuser_country-_session-[a-f0-9]{8}_lifetime-30m$/.test(a.username),
    a.username);
}

function testRegistryListVendors() {
  const vendors = registry.listVendors();
  const names = vendors.map((v) => v.vendor).sort();
  const expected = ['custom', 'iproyal', 'proxyempire', 'smartproxy', 'soax'];
  ok('registry.vendorList',
    JSON.stringify(names) === JSON.stringify(expected),
    JSON.stringify(names));
}

function testRegistryGetDriver() {
  ok('registry.getDriver.iproyal',
    registry.getDriver('iproyal') instanceof IPRoyalDriver);
  ok('registry.getDriver.unknown',
    registry.getDriver('definitely-not-a-vendor') === null);
}

(async () => {
  testRegistryListVendors();
  testRegistryGetDriver();
  await testIPRoyalProvision();
  await testIPRoyalNoCountry();
  await testIPRoyalRotate();
  await testSoaxProvision();
  await testProxyEmpireProvision();
  await testSmartproxyProvision();
  await testCustomTemplate();
  await testCustomEmptyCountryCollapses();

  console.log(`\nproxyProviderDriver.smoke.test: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
})();
