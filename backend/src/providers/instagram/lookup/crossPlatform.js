/**
 * §2.5 Cross-platform username probe (Sherlock-style).
 *
 * Pure HTTP HEAD/GET probes against ~50 services to surface accounts
 * with the same handle as the IG username. No credentials, no
 * impersonation — just "does this handle exist?".
 *
 * Each probe is bounded by `lookupLimiter` so we don't fan out 50
 * parallel requests from the same IP.
 */

'use strict';

const logger = require('../../../utils/logger');
const lookupLimiter = require('./lookupLimiter');

const SITES = [
  { name: 'GitHub',       url: (u) => `https://github.com/${u}`,                  ok: 'status', okStatus: 200 },
  { name: 'GitLab',       url: (u) => `https://gitlab.com/${u}`,                  ok: 'status', okStatus: 200 },
  { name: 'Bitbucket',    url: (u) => `https://bitbucket.org/${u}`,               ok: 'status', okStatus: 200 },
  { name: 'Twitter / X',  url: (u) => `https://twitter.com/${u}`,                 ok: 'status', okStatus: 200 },
  { name: 'Reddit',       url: (u) => `https://www.reddit.com/user/${u}/about.json`, ok: 'json',  okPath: 'data.name' },
  { name: 'TikTok',       url: (u) => `https://www.tiktok.com/@${u}`,             ok: 'status', okStatus: 200 },
  { name: 'YouTube',      url: (u) => `https://www.youtube.com/@${u}`,            ok: 'status', okStatus: 200 },
  { name: 'Twitch',       url: (u) => `https://www.twitch.tv/${u}`,               ok: 'status', okStatus: 200 },
  { name: 'Pinterest',    url: (u) => `https://www.pinterest.com/${u}/`,          ok: 'status', okStatus: 200 },
  { name: 'Vimeo',        url: (u) => `https://vimeo.com/${u}`,                   ok: 'status', okStatus: 200 },
  { name: 'Medium',       url: (u) => `https://medium.com/@${u}`,                 ok: 'status', okStatus: 200 },
  { name: 'Dev.to',       url: (u) => `https://dev.to/${u}`,                      ok: 'status', okStatus: 200 },
  { name: 'StackOverflow',url: (u) => `https://stackoverflow.com/users/${u}`,     ok: 'status', okStatus: 200 },
  { name: 'Behance',      url: (u) => `https://www.behance.net/${u}`,             ok: 'status', okStatus: 200 },
  { name: 'Dribbble',     url: (u) => `https://dribbble.com/${u}`,                ok: 'status', okStatus: 200 },
  { name: 'SoundCloud',   url: (u) => `https://soundcloud.com/${u}`,              ok: 'status', okStatus: 200 },
  { name: 'Spotify',      url: (u) => `https://open.spotify.com/user/${u}`,       ok: 'status', okStatus: 200 },
  { name: 'Steam',        url: (u) => `https://steamcommunity.com/id/${u}`,       ok: 'status', okStatus: 200 },
  { name: 'Roblox',       url: (u) => `https://www.roblox.com/user.aspx?username=${u}`, ok: 'status', okStatus: 200 },
  { name: 'Patreon',      url: (u) => `https://www.patreon.com/${u}`,             ok: 'status', okStatus: 200 },
  { name: 'Ko-fi',        url: (u) => `https://ko-fi.com/${u}`,                   ok: 'status', okStatus: 200 },
  { name: 'BuyMeACoffee', url: (u) => `https://www.buymeacoffee.com/${u}`,        ok: 'status', okStatus: 200 },
  { name: 'Linktree',     url: (u) => `https://linktr.ee/${u}`,                   ok: 'status', okStatus: 200 },
  { name: 'OnlyFans',     url: (u) => `https://onlyfans.com/${u}`,                ok: 'status', okStatus: 200 },
  { name: 'Tumblr',       url: (u) => `https://${u}.tumblr.com/`,                 ok: 'status', okStatus: 200 },
  { name: 'Etsy',         url: (u) => `https://www.etsy.com/shop/${u}`,           ok: 'status', okStatus: 200 },
  { name: 'Snapchat',     url: (u) => `https://www.snapchat.com/add/${u}`,        ok: 'status', okStatus: 200 },
  { name: 'Threads',      url: (u) => `https://www.threads.net/@${u}`,            ok: 'status', okStatus: 200 },
  { name: 'BlueSky',      url: (u) => `https://bsky.app/profile/${u}.bsky.social`,ok: 'status', okStatus: 200 },
  { name: 'Mastodon',     url: (u) => `https://mastodon.social/@${u}`,            ok: 'status', okStatus: 200 },
  { name: 'Flickr',       url: (u) => `https://www.flickr.com/people/${u}`,      ok: 'status', okStatus: 200 },
  { name: 'Quora',        url: (u) => `https://www.quora.com/profile/${u}`,      ok: 'status', okStatus: 200 },
  { name: 'Discord',      url: (u) => `https://discord.com/users/${u}`,           ok: 'status', okStatus: 200 },
  { name: 'Goodreads',    url: (u) => `https://www.goodreads.com/${u}`,           ok: 'status', okStatus: 200 },
  { name: 'Last.fm',      url: (u) => `https://www.last.fm/user/${u}`,            ok: 'status', okStatus: 200 },
  { name: 'Kaggle',       url: (u) => `https://www.kaggle.com/${u}`,              ok: 'status', okStatus: 200 },
  { name: 'HackerNews',   url: (u) => `https://news.ycombinator.com/user?id=${u}`, ok: 'status', okStatus: 200 },
  { name: 'ProductHunt',  url: (u) => `https://www.producthunt.com/@${u}`,        ok: 'status', okStatus: 200 },
  { name: 'Imgur',        url: (u) => `https://imgur.com/user/${u}`,              ok: 'status', okStatus: 200 },
  { name: 'Replit',       url: (u) => `https://replit.com/@${u}`,                 ok: 'status', okStatus: 200 },
  { name: 'CodePen',      url: (u) => `https://codepen.io/${u}`,                  ok: 'status', okStatus: 200 },
  { name: 'Trakt',        url: (u) => `https://trakt.tv/users/${u}`,              ok: 'status', okStatus: 200 },
  { name: 'Wattpad',      url: (u) => `https://www.wattpad.com/user/${u}`,        ok: 'status', okStatus: 200 },
  { name: 'Hashnode',     url: (u) => `https://hashnode.com/@${u}`,               ok: 'status', okStatus: 200 },
  { name: 'AngelList',    url: (u) => `https://wellfound.com/${u}`,               ok: 'status', okStatus: 200 },
  { name: 'Substack',     url: (u) => `https://${u}.substack.com`,                ok: 'status', okStatus: 200 },
];

async function _probe(site, username) {
  const url = site.url(username);
  // Use HEAD when supported — some services (Reddit, Threads) return
  // weird redirects on HEAD so we fall back to GET on those.
  const method = site.ok === 'json' ? 'GET' : 'HEAD';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6_000);
    const res = await fetch(url, {
      method,
      redirect: 'manual',
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        accept: 'text/html,application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (site.ok === 'json') {
      // GET path with JSON body parse.
      let body;
      try { body = await res.json(); } catch (_e) { body = null; }
      const path = site.okPath ? site.okPath.split('.') : [];
      let v = body;
      for (const p of path) v = v && v[p];
      if (v && String(v).toLowerCase() === username.toLowerCase()) {
        return { name: site.name, url, confidence: 90 };
      }
      return null;
    }
    if (res.status === site.okStatus) {
      return { name: site.name, url, confidence: 75 };
    }
    return null;
  } catch (_err) {
    return null;
  }
}

async function run(username, opts = {}) {
  if (!username || typeof username !== 'string') return { method: 'cross_platform', ok: false, error: 'invalid_input', findings: [] };
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
    raw: { probed: SITES.length, matched: findings.length },
  };
}

module.exports = { run, SITES };
