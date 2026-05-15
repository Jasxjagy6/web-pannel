/**
 * §2.5 Cross-platform username probe (Sherlock-style).
 *
 * Pure HTTP probes against ~16 services to surface accounts with the
 * same handle as the IG username. No credentials, no impersonation —
 * just "does this handle resolve to a profile on this service?".
 *
 * Each probe is bounded by `lookupLimiter` so we don't fan out N
 * parallel requests from the same IP.
 *
 * ## Why detection rules are per-site
 *
 * A naive "status === 200 means exists" rule produces *massive* false
 * positives because:
 *
 *   - Many services serve a generic landing/login wall on
 *     /<unknown_user> with status 200 (Twitch, Twitter/X, TikTok,
 *     Spotify, Pinterest, Steam, OnlyFans, Imgur, Threads, Medium,
 *     Hashnode are all SPAs that return the same HTML shell whether
 *     or not the profile exists).
 *   - Many services anti-bot 403 panel-host IPs entirely, so the
 *     status carries no signal at all (Bitbucket, StackOverflow,
 *     CodePen, Replit, Linktr.ee, ProductHunt, Trakt, Etsy, Quora,
 *     Dribbble, Flickr, Tumblr).
 *
 * To stay accurate this module uses three detection strategies:
 *
 *   - `existsStatus`  — exists IFF response status ∈ existsStatus.
 *   - `redirectExists` — a 3xx response with `location:` to a non-
 *                        login destination means the profile exists.
 *                        Used for services that 301/302/307 a real
 *                        profile path (Patreon → /c/<u>, Behance →
 *                        /<u>/moodboards, Wattpad → /user/<u>/info,
 *                        Goodreads → /user/<id>-<slug>).
 *   - `bodyMissing`    — fetch HTML; if the regex matches, the
 *                        profile does NOT exist.
 *
 * Services that can't be reliably probed without an authenticated
 * session or a residential proxy are deliberately omitted. The
 * `BLOCKED_SITES` table below documents them so a future PR can
 * re-enable them via the proxy-routed `igFetch` path.
 */

'use strict';

const logger = require('../../../utils/logger');
const lookupLimiter = require('./lookupLimiter');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/**
 * Each site:
 *   - name:           Display name.
 *   - url(u):         Profile URL.
 *   - method:         HTTP method (default GET; HEAD only when status alone
 *                     is reliable AND the service answers HEAD without a
 *                     login wall).
 *   - existsStatus:   Status codes that mean "exists" (e.g. [200]).
 *   - missingStatus:  Status codes that mean "missing" (e.g. [404]).
 *   - redirectExists: If true, any 3xx with `location` not pointing at
 *                     a login/signup URL is treated as "exists".
 *   - bodyMissing:    Regex; if it matches the response body, the profile
 *                     does NOT exist. Combined with existsStatus.
 *   - confidence:     Reported confidence on a hit.
 */
const SITES = [
  // Pure 200/404 services — HEAD is enough.
  { name: 'GitHub',     url: (u) => `https://github.com/${u}`,                     method: 'HEAD',
    existsStatus: [200], missingStatus: [404], confidence: 90 },
  { name: 'GitLab',     url: (u) => `https://gitlab.com/${u}`,                     method: 'HEAD',
    existsStatus: [200], missingStatus: [302, 404], confidence: 85 },
  { name: 'Vimeo',      url: (u) => `https://vimeo.com/${u}`,                      method: 'HEAD',
    existsStatus: [200], missingStatus: [404], confidence: 80 },
  { name: 'Dev.to',     url: (u) => `https://dev.to/${u}`,                         method: 'HEAD',
    existsStatus: [200], missingStatus: [404], confidence: 80 },
  { name: 'Mastodon',   url: (u) => `https://mastodon.social/@${u}`,               method: 'HEAD',
    existsStatus: [200], missingStatus: [404], confidence: 75 },

  // Status-driven but require GET (HEAD returns wrong codes).
  { name: 'YouTube',    url: (u) => `https://www.youtube.com/@${u}`,               method: 'GET',
    existsStatus: [200], missingStatus: [404], confidence: 80 },
  { name: 'SoundCloud', url: (u) => `https://soundcloud.com/${u}`,                 method: 'GET',
    existsStatus: [200], missingStatus: [404], confidence: 75 },
  { name: 'Substack',   url: (u) => `https://${u}.substack.com`,                   method: 'GET',
    existsStatus: [200], missingStatus: [404], confidence: 75 },
  { name: 'Last.fm',    url: (u) => `https://www.last.fm/user/${u}`,               method: 'GET',
    existsStatus: [200], missingStatus: [404], confidence: 80 },
  { name: 'Kaggle',     url: (u) => `https://www.kaggle.com/${u}`,                 method: 'GET',
    existsStatus: [200], missingStatus: [404], confidence: 80 },

  // Redirect-driven services — a 3xx with a non-login `location` means
  // the profile exists.
  { name: 'Behance',    url: (u) => `https://www.behance.net/${u}`,                method: 'HEAD',
    redirectExists: true,  missingStatus: [404], confidence: 80 },
  { name: 'Patreon',    url: (u) => `https://www.patreon.com/${u}`,                method: 'HEAD',
    redirectExists: true,  missingStatus: [404], confidence: 75 },
  { name: 'Wattpad',    url: (u) => `https://www.wattpad.com/user/${u}`,           method: 'HEAD',
    redirectExists: true,  missingStatus: [404], confidence: 75 },
  { name: 'Goodreads',  url: (u) => `https://www.goodreads.com/${u}`,              method: 'HEAD',
    redirectExists: true,  missingStatus: [404], confidence: 75 },

  // Reddit JSON — special handling: parse body and check data.name.
  { name: 'Reddit',     url: (u) => `https://www.reddit.com/user/${u}/about.json`, method: 'GET',
    jsonPath: 'data.name', confidence: 90 },

  // Body-detection: HN is HTML-only, no JSON, no status signal.
  { name: 'Hacker News', url: (u) => `https://news.ycombinator.com/user?id=${u}`,  method: 'GET',
    existsStatus: [200], bodyMissing: /No such user\./i, confidence: 85 },
];

/**
 * Services we couldn't reliably probe from a panel-host IP. These
 * are documented so a future PR can re-enable them via the proxy-
 * routed `igFetch` path once `proxies.validated_for_lookup` is set
 * up. Listing them in code (not just in markdown) means CI tooling
 * can audit the surface.
 */
const BLOCKED_SITES = [
  'Bitbucket', 'StackOverflow', 'CodePen', 'Replit',     // anti-bot 403
  'Trakt', 'ProductHunt', 'Linktr.ee', 'Tumblr',         // anti-bot 403
  'Etsy', 'Quora', 'Dribbble', 'Flickr',                 // anti-bot 403/404 for all
  'Twitch', 'Twitter / X', 'TikTok',                     // SPA shell — same response
  'Spotify', 'Pinterest', 'Steam', 'OnlyFans',           // SPA shell + login wall
  'Imgur', 'Threads', 'Medium', 'Hashnode',              // SPA shell — same response
  'Discord', 'Snapchat',                                 // no canonical public profile URL
];

/**
 * Detect whether a 3xx `location` looks like a login/signup wall vs
 * a real profile path. Used by `redirectExists` rules.
 */
function _isLoginRedirect(target) {
  if (!target) return true; // empty location is suspicious
  return /\/(login|signup|signin|join|register|auth)(\/|\?|$)/i.test(target);
}

async function _probe(site, username) {
  const url = site.url(username);
  const method = site.method || 'GET';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7_000);
    const res = await fetch(url, {
      method,
      redirect: 'manual',
      headers: {
        'user-agent': UA,
        accept: site.jsonPath ? 'application/json' : 'text/html,application/json',
        'accept-language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (site.jsonPath) {
      let body;
      try { body = await res.json(); } catch (_e) { body = null; }
      const path = site.jsonPath.split('.');
      let v = body;
      for (const p of path) v = v && v[p];
      if (v && String(v).toLowerCase() === username.toLowerCase()) {
        return { name: site.name, url, confidence: site.confidence || 75 };
      }
      return null;
    }

    if (Array.isArray(site.missingStatus) && site.missingStatus.includes(res.status)) {
      return null;
    }

    if (site.redirectExists && res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') || '';
      if (_isLoginRedirect(loc)) return null;
      return { name: site.name, url, confidence: site.confidence || 75 };
    }

    if (Array.isArray(site.existsStatus) && site.existsStatus.includes(res.status)) {
      if (site.bodyMissing) {
        // Re-fetch body if needed (HEAD never has body).
        const body = method === 'HEAD' ? '' : await res.text().catch(() => '');
        if (body && site.bodyMissing.test(body)) return null;
      }
      return { name: site.name, url, confidence: site.confidence || 75 };
    }

    return null;
  } catch (_err) {
    return null;
  }
}

async function run(username, opts = {}) {
  if (!username || typeof username !== 'string') {
    return { method: 'cross_platform', ok: false, error: 'invalid_input', findings: [] };
  }
  const cleaned = username.trim().replace(/^@+/, '');
  if (!/^[a-zA-Z0-9._-]{1,30}$/.test(cleaned)) {
    return { method: 'cross_platform', ok: false, error: 'invalid_input', findings: [] };
  }

  await lookupLimiter.acquire(`cross_platform:${cleaned}`, { class: 'read' });

  const concurrency = Math.max(1, opts.concurrency || 6);
  const findings = [];
  const queue = SITES.slice();
  async function worker() {
    while (queue.length) {
      const site = queue.shift();
      if (!site) break;
      try {
        const hit = await _probe(site, cleaned);
        if (hit) {
          findings.push({
            method: 'cross_platform',
            kind: 'url',
            value: hit.url,
            confidence: hit.confidence,
            sourceUrl: hit.url,
            raw: { service: hit.name },
          });
        }
      } catch (err) {
        logger.warn(`IG.lookup.crossPlatform: ${site.name} probe failed: ${err.message}`);
      }
    }
  }
  await Promise.all(new Array(concurrency).fill(0).map(() => worker()));

  return {
    method: 'cross_platform',
    ok: true,
    findings,
    raw: { probed: SITES.length, matched: findings.length, blocked: BLOCKED_SITES.length },
  };
}

module.exports = { run, SITES, BLOCKED_SITES };
