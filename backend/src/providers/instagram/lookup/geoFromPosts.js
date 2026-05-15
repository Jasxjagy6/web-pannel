/**
 * §2.8 geoFromPosts — extract a city/area signal from a target's most
 * recent tagged-location posts.
 *
 * The function reads the user's first page of timeline media via the
 * web GraphQL endpoint and aggregates non-null `location.name`,
 * `location.city`, and `location.address_json.country_code` fields
 * into a ranked top-N city list.
 *
 * This is NOT IP geolocation. It is NOT a real-time location track.
 * The user's account opted into displaying these locations publicly.
 *
 * The function gracefully no-ops when the panel has no logged-in IG
 * session — IG's timeline endpoint refuses anonymous requests in
 * 2024+.
 */

'use strict';

const logger = require('../../../utils/logger');
const { igFetch, sessionContext } = require('../igFetch');
const lookupLimiter = require('./lookupLimiter');

const WEB_PROFILE_INFO = (u) =>
  `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(u)}`;

// Pulls the user's most recent N posts. IG's web feed endpoint exposes
// the location object on each media node directly.
const USER_FEED = (pk, count = 24) =>
  `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(pk)}/?count=${count}`;

async function run(username, opts = {}) {
  if (!username || typeof username !== 'string') {
    return { method: 'geo_from_posts', ok: false, error: 'invalid_input', findings: [] };
  }
  const cleaned = username.trim().replace(/^@+/, '').toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/i.test(cleaned)) {
    return { method: 'geo_from_posts', ok: false, error: 'invalid_input', findings: [] };
  }

  if (!opts.session || !opts.session.id) {
    return {
      method: 'geo_from_posts',
      ok: false,
      error: 'session_required',
      message: 'geoFromPosts needs a logged-in IG session to read the timeline feed.',
      findings: [],
    };
  }

  await lookupLimiter.acquire(`geo:${cleaned}`, { class: 'read' });
  let ctx;
  try {
    ctx = await sessionContext(opts.session);
  } catch (err) {
    return { method: 'geo_from_posts', ok: false, error: 'session_invalid', message: err.message, findings: [] };
  }

  // Resolve username -> pk first.
  let igPk;
  try {
    const profile = await igFetch(ctx, WEB_PROFILE_INFO(cleaned), {
      referer: `https://www.instagram.com/${cleaned}/`,
    });
    igPk = profile && profile.data && profile.data.user && (profile.data.user.id || profile.data.user.pk);
  } catch (err) {
    return { method: 'geo_from_posts', ok: false, error: err.kind || 'network', message: err.message, findings: [] };
  }
  if (!igPk) {
    return { method: 'geo_from_posts', ok: false, error: 'not_found', message: 'IG returned no pk for username', findings: [] };
  }

  let feed;
  try {
    feed = await igFetch(ctx, USER_FEED(igPk, opts.count || 24), {
      referer: `https://www.instagram.com/${cleaned}/`,
    });
  } catch (err) {
    return { method: 'geo_from_posts', ok: false, error: err.kind || 'network', message: err.message, findings: [] };
  }

  const items = (feed && Array.isArray(feed.items)) ? feed.items : [];
  const locCounts = new Map();
  for (const item of items) {
    const loc = item && item.location;
    if (!loc) continue;
    const name = loc.name || loc.short_name || null;
    if (!name) continue;
    let addr = loc.address_json;
    if (typeof addr === 'string') {
      try { addr = JSON.parse(addr); } catch (_e) { addr = null; }
    }
    const city = (addr && (addr.city_name || addr.region_name)) || null;
    const country = (addr && (addr.country_name || addr.country_code)) || null;
    const key = `${name}||${city || ''}||${country || ''}`;
    const prev = locCounts.get(key) || { name, city, country, count: 0 };
    prev.count += 1;
    locCounts.set(key, prev);
  }

  const sorted = Array.from(locCounts.values()).sort((a, b) => b.count - a.count);
  const findings = sorted.slice(0, 5).map((loc) => {
    const valueParts = [loc.name, loc.city, loc.country].filter(Boolean);
    return {
      method: 'geo_from_posts',
      kind: 'location',
      value: valueParts.join(', '),
      confidence: Math.min(90, 50 + loc.count * 5),
      sourceUrl: `https://www.instagram.com/${cleaned}/`,
      raw: loc,
    };
  });

  logger.info(`IG.lookup.geoFromPosts: ${cleaned} pk=${igPk} → ${findings.length} loc clusters from ${items.length} posts`);
  return { method: 'geo_from_posts', ok: true, findings, raw: { posts_scanned: items.length, clusters: sorted.length } };
}

module.exports = { run };
