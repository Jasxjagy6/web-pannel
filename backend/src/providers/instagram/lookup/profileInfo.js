/**
 * §2.1 web_profile_info — public profile probe.
 *
 * Pulls the username's `/api/v1/users/web_profile_info/?username=...`
 * endpoint and extracts every primitive IG returns about the account:
 *
 *   - public business email          → kind=email
 *   - public business phone          → kind=phone
 *   - public business address        → kind=address (multi-line)
 *   - external website / link-tree   → kind=url
 *   - full_name                      → kind=name
 *   - profile pic URL                → kind=profile_url
 *   - is_verified / is_business      → kind=note flags
 *
 * No cookies required for the endpoint, but IG enforces an `x-ig-app-id`
 * + browser headers — which we already get from igFetch.browserHeaders.
 * To make this work even when the operator has zero IG sessions
 * uploaded, we synthesise a cookie-less ctx that igFetch accepts via
 * the `skipLimiter` opt (we still enforce our own lookupLimiter).
 *
 * Throws AppError on hard errors; returns { findings: [...], igPk,
 * snapshot } on success.
 */

'use strict';

const logger = require('../../../utils/logger');
const { igFetch, pickWebFingerprint } = require('../igFetch');
const lookupLimiter = require('./lookupLimiter');
const { AppError } = require('../../../utils/errorHandler');

const WEB_PROFILE_INFO = (u) =>
  `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(u)}`;

function _anonymousCtx(username) {
  // A cookie-less ctx — igFetch accepts it but classifyError will
  // turn anonymous-blocked responses into a clean 401. For the
  // web_profile_info endpoint a recent IG anti-bot push requires a
  // valid csrftoken cookie, so we pass an empty cookie header and
  // explicitly tell igFetch to skip its limiter (we run our own).
  return {
    sessionId: `lookup:${username}`,
    username: null,
    proxyUrl: null,
    bypassProxy: true,
    allowAnonymous: true,
    cookieHeader: '',
    csrftoken: '',
    dsUserId: null,
    blob: null,
    webFingerprint: pickWebFingerprint(`lookup_anon_${username}`),
    locale: { language: 'en_US', timezoneOffset: 0, regionHint: 'US' },
    apiMode: 'web',
  };
}

/**
 * Lookup wrapper. When a logged-in IG session is available we prefer
 * it (a sessionid cookie unlocks more fields, notably the business
 * email/phone on accounts that hide them from anonymous viewers).
 * Without one, we fall through to anonymous.
 */
async function _resolveCtx(username, opts) {
  if (opts && opts.session && opts.session.id) {
    // eslint-disable-next-line global-require
    const { sessionContext } = require('../igFetch');
    return sessionContext(opts.session);
  }
  return _anonymousCtx(username);
}

async function run(username, opts = {}) {
  if (!username || typeof username !== 'string') {
    throw new AppError('profileInfo.run: username required', 400, 'VALIDATION_ERROR');
  }
  const cleaned = username.trim().replace(/^@+/, '').toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/i.test(cleaned)) {
    throw new AppError('profileInfo.run: invalid IG username', 400, 'VALIDATION_ERROR');
  }
  await lookupLimiter.acquire(cleaned, { class: 'read' });
  const ctx = await _resolveCtx(cleaned, opts);
  let payload;
  try {
    payload = await igFetch(ctx, WEB_PROFILE_INFO(cleaned), {
      referer: `https://www.instagram.com/${cleaned}/`,
      skipLimiter: true,
      logErrors: false,
    });
  } catch (err) {
    // Re-export as a recognised method-level error so the runner can
    // record `error_methods += 1` without aborting the whole job.
    return {
      method: 'profile_info',
      ok: false,
      error: err.kind || 'network',
      message: err.message || 'IG profile lookup failed',
      findings: [],
      raw: null,
    };
  }
  const user = payload && payload.data && payload.data.user;
  if (!user) {
    return {
      method: 'profile_info',
      ok: false,
      error: 'not_found',
      message: 'IG returned no user object for that username',
      findings: [],
      raw: payload || null,
    };
  }

  const findings = [];

  if (user.full_name) {
    findings.push({
      method: 'profile_info',
      kind: 'name',
      value: user.full_name,
      confidence: 90,
      sourceUrl: `https://www.instagram.com/${cleaned}/`,
    });
  }

  if (user.business_email) {
    findings.push({
      method: 'profile_info',
      kind: 'email',
      value: String(user.business_email).trim().toLowerCase(),
      confidence: 95,
      verified: true,
      sourceUrl: `https://www.instagram.com/${cleaned}/`,
      raw: { source: 'business_contact' },
    });
  }
  if (user.public_email) {
    findings.push({
      method: 'profile_info',
      kind: 'email',
      value: String(user.public_email).trim().toLowerCase(),
      confidence: 90,
      verified: true,
      sourceUrl: `https://www.instagram.com/${cleaned}/`,
      raw: { source: 'public_email' },
    });
  }
  if (user.business_phone_number) {
    findings.push({
      method: 'profile_info',
      kind: 'phone',
      value: String(user.business_phone_number).trim(),
      confidence: 90,
      verified: true,
      sourceUrl: `https://www.instagram.com/${cleaned}/`,
      raw: { source: 'business_contact' },
    });
  }
  if (user.public_phone_number) {
    const cc = user.public_phone_country_code
      ? `+${String(user.public_phone_country_code).replace(/[^0-9]/g, '')}`
      : '';
    findings.push({
      method: 'profile_info',
      kind: 'phone',
      value: `${cc}${user.public_phone_number}`.trim(),
      confidence: 90,
      verified: true,
      sourceUrl: `https://www.instagram.com/${cleaned}/`,
      raw: { source: 'public_phone' },
    });
  }
  if (user.business_address_json) {
    let addr = user.business_address_json;
    try {
      if (typeof addr === 'string') addr = JSON.parse(addr);
    } catch (_err) {
      // leave as-is
    }
    const parts = [];
    if (addr && typeof addr === 'object') {
      for (const key of ['street_address', 'city_name', 'region_name', 'zip_code', 'country_name']) {
        if (addr[key]) parts.push(String(addr[key]));
      }
    }
    if (parts.length) {
      findings.push({
        method: 'profile_info',
        kind: 'address',
        value: parts.join(', '),
        confidence: 95,
        verified: true,
        sourceUrl: `https://www.instagram.com/${cleaned}/`,
        raw: addr,
      });
    }
  }
  if (user.external_url) {
    findings.push({
      method: 'profile_info',
      kind: 'url',
      value: String(user.external_url),
      confidence: 90,
      verified: true,
      sourceUrl: `https://www.instagram.com/${cleaned}/`,
      raw: { source: 'external_url' },
    });
  }
  if (Array.isArray(user.bio_links)) {
    for (const link of user.bio_links) {
      if (link && link.url) {
        findings.push({
          method: 'profile_info',
          kind: 'url',
          value: String(link.url),
          confidence: 85,
          sourceUrl: `https://www.instagram.com/${cleaned}/`,
          raw: { source: 'bio_link', title: link.title || null },
        });
      }
    }
  }
  if (user.profile_pic_url_hd || user.profile_pic_url) {
    findings.push({
      method: 'profile_info',
      kind: 'profile_url',
      value: user.profile_pic_url_hd || user.profile_pic_url,
      confidence: 95,
      verified: true,
      sourceUrl: `https://www.instagram.com/${cleaned}/`,
    });
  }

  if (user.biography) {
    findings.push({
      method: 'profile_info',
      kind: 'note',
      value: `bio: ${String(user.biography).slice(0, 280)}`,
      confidence: 100,
      sourceUrl: `https://www.instagram.com/${cleaned}/`,
    });
  }

  const flags = [];
  if (user.is_verified) flags.push('verified');
  if (user.is_business_account) flags.push('business');
  if (user.is_private) flags.push('private'); else flags.push('public');
  if (user.is_professional_account) flags.push('professional');
  if (flags.length) {
    findings.push({
      method: 'profile_info',
      kind: 'note',
      value: `flags: ${flags.join(', ')}`,
      confidence: 100,
      sourceUrl: `https://www.instagram.com/${cleaned}/`,
    });
  }

  const igPk = user.id || user.pk || null;
  if (igPk) {
    findings.push({
      method: 'profile_info',
      kind: 'note',
      value: `ig_id: ${igPk}`,
      confidence: 100,
      sourceUrl: `https://www.instagram.com/${cleaned}/`,
      raw: { ig_id: String(igPk) },
    });
  }

  const followers = user.edge_followed_by ? user.edge_followed_by.count : user.follower_count;
  const following = user.edge_follow ? user.edge_follow.count : user.following_count;
  const media = user.edge_owner_to_timeline_media
    ? user.edge_owner_to_timeline_media.count
    : user.media_count;
  if (Number.isFinite(followers) || Number.isFinite(following) || Number.isFinite(media)) {
    findings.push({
      method: 'profile_info',
      kind: 'note',
      value: `counts: followers=${followers ?? '?'} following=${following ?? '?'} posts=${media ?? '?'}`,
      confidence: 100,
      sourceUrl: `https://www.instagram.com/${cleaned}/`,
      raw: { followers, following, media },
    });
  }

  if (user.category_name || user.category) {
    findings.push({
      method: 'profile_info',
      kind: 'note',
      value: `category: ${user.category_name || user.category}`,
      confidence: 100,
      sourceUrl: `https://www.instagram.com/${cleaned}/`,
    });
  }

  if (user.connected_fb_page) {
    findings.push({
      method: 'profile_info',
      kind: 'url',
      value: `https://www.facebook.com/${user.connected_fb_page}`,
      confidence: 95,
      verified: true,
      sourceUrl: `https://www.instagram.com/${cleaned}/`,
      raw: { source: 'connected_fb_page' },
    });
  }

  logger.info(`IG.lookup.profileInfo: ${cleaned} → ${findings.length} findings`);

  return {
    method: 'profile_info',
    ok: true,
    igPk: user.id || user.pk || null,
    findings,
    raw: {
      username: user.username,
      full_name: user.full_name,
      is_verified: !!user.is_verified,
      is_business_account: !!user.is_business_account,
      is_private: !!user.is_private,
      follower_count: user.edge_followed_by ? user.edge_followed_by.count : user.follower_count,
      following_count: user.edge_follow ? user.edge_follow.count : user.following_count,
      media_count: user.edge_owner_to_timeline_media
        ? user.edge_owner_to_timeline_media.count
        : user.media_count,
    },
  };
}

module.exports = { run };
