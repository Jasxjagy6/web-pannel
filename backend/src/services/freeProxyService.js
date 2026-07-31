'use strict';

/**
 * Free proxy fetcher + validator for the link-username filter.
 *
 * Pulls candidates from several public proxy lists, tests each one
 * against t.me (the exact target), and returns the first N that work.
 * Falls back gracefully — callers always get an array (possibly empty).
 */

const { request, ProxyAgent } = require('undici');
const logger = require('../utils/logger');

const SOURCES = [
  'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=5000&country=all&ssl=all&anonymity=all',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
  'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
  'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
];

const TEST_URL    = 'https://t.me/telegram';   // known-valid t.me page
const FETCH_MS    = 12000;
const TEST_MS     = 8000;
const MAX_TEST    = 40;   // how many candidates to try before giving up
const IP_PORT_RE  = /^(\d{1,3}\.){3}\d{1,3}:\d{2,5}$/;

/** Pull raw ip:port lines from all sources, deduplicated. */
async function fetchCandidates() {
  const seen = new Set();
  for (const src of SOURCES) {
    try {
      const res = await request(src, {
        method: 'GET',
        bodyTimeout: FETCH_MS,
        headersTimeout: FETCH_MS,
      });
      const text = await res.body.text();
      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (IP_PORT_RE.test(line)) seen.add(line);
      }
      if (seen.size >= 500) break;
    } catch (e) {
      logger.debug(`freeProxy: source fetch failed (${src}): ${e.message}`);
    }
  }
  return Array.from(seen);
}

/** Test one proxy URL against t.me. Returns true if it works. */
async function testProxy(proxyUrl) {
  let agent;
  try {
    agent = new ProxyAgent(proxyUrl);
    const res = await request(TEST_URL, {
      method: 'GET',
      dispatcher: agent,
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      bodyTimeout: TEST_MS,
      headersTimeout: TEST_MS,
      maxRedirections: 3,
    });
    const body = await res.body.text();
    // Accept if page loaded and has real content (not a proxy error page)
    return res.statusCode === 200 && body.length > 1000;
  } catch {
    return false;
  } finally {
    agent?.close().catch(() => {});
  }
}

/**
 * Fetch `count` working free HTTP proxies that can reach t.me.
 * Returns an array of proxy URLs ("http://ip:port"), possibly shorter
 * than `count` if not enough working ones were found. Returns [] on
 * complete failure so callers can fall back to direct VPS IP.
 */
async function getFreeProxies(count = 3) {
  try {
    logger.info(`freeProxy: fetching candidates for ${count} proxy slots...`);
    const candidates = await fetchCandidates();
    if (candidates.length === 0) {
      logger.warn('freeProxy: no candidates found from any source');
      return [];
    }

    // Shuffle for diversity, cap the number we actually test
    const toTest = candidates
      .sort(() => Math.random() - 0.5)
      .slice(0, MAX_TEST);

    logger.info(`freeProxy: testing ${toTest.length} of ${candidates.length} candidates...`);

    const working = [];
    const BATCH = 5;
    for (let i = 0; i < toTest.length && working.length < count; i += BATCH) {
      const batch = toTest.slice(i, i + BATCH);
      const results = await Promise.all(
        batch.map(async (ipPort) => {
          const url = `http://${ipPort}`;
          const ok = await testProxy(url);
          if (ok) logger.info(`freeProxy: ✓ working: ${url}`);
          return ok ? url : null;
        })
      );
      for (const r of results) {
        if (r && working.length < count) working.push(r);
      }
    }

    logger.info(`freeProxy: found ${working.length}/${count} working proxies`);
    return working;
  } catch (err) {
    logger.warn(`freeProxy: unexpected error: ${err.message}`);
    return [];
  }
}

module.exports = { getFreeProxies };
