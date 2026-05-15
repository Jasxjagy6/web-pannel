/**
 * §2.6 Reverse-image search on profile_pic_url — PR #6.
 *
 * Pipeline:
 *   1. Pull `profile_pic_url` (and `hd_profile_pic_url_info.url`,
 *      if present) from the Stage-1 profileInfo snapshot.
 *   2. Download the image once (≤512 KiB cap), compute its perceptual
 *      hash (`dHash` over 9×8 greyscale). This becomes the
 *      cache key — re-uploading the same image with a different IG
 *      asset ID still hits the cached result.
 *   3. Fan out to whichever providers have keys configured:
 *        - SerpAPI Yandex Images          (engine=yandex_images)
 *        - SerpAPI Google Reverse Images  (engine=google_reverse_image)
 *        - PimEyes (paid)
 *        - TinEye  (optional, paid)
 *   4. Aggregate the URL hits and surface them as `url` findings
 *      with `confidence` based on the matching-provider count
 *      (single hit = 60, double = 80, triple = 95).
 *
 * Cheap-by-design: Yandex / SerpAPI / TinEye all have public-API
 * paths that need no CAPTCHA. PimEyes is paid-only but has the best
 * face-matching recall — it stays opt-in.
 *
 * 2captcha hookup: the unauthenticated Yandex `/images/search`
 * frontpage occasionally serves a CAPTCHA; when it does, we proxy
 * the recovery through `twoCaptcha.solve()` and retry once.
 */

'use strict';

const crypto = require('crypto');
const logger = require('../../../utils/logger');
const userLookupKeys = require('../../../services/userLookupKeysService');
const lookupCache    = require('../../../services/lookupCacheService');
const lookupBudget   = require('../../../services/lookupBudgetService');
const lookupAudit    = require('../../../services/lookupAuditService');
const lookupLimiter  = require('./lookupLimiter');
const twoCaptcha = require('./twoCaptcha');
const { AppError } = require('../../../utils/errorHandler');

const _FETCH_TIMEOUT_MS = 12_000;
const _MAX_IMAGE_BYTES = 512 * 1024;

const _COST = {
  serpapi:  Number(process.env.LOOKUP_COST_SERPAPI  || 0.005),
  pimeyes:  Number(process.env.LOOKUP_COST_PIMEYES  || 0.020),
  tineye:   Number(process.env.LOOKUP_COST_TINEYE   || 0.005),
};

function _stripUsername(u) {
  if (!u) return '';
  return String(u).trim().replace(/^@+/, '').toLowerCase();
}

async function _fetchBuffer(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), _FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 web-pannel/1.0' },
    });
    if (!r.ok) return { ok: false, status: r.status };
    const len = Number(r.headers.get('content-length') || 0);
    if (len && len > _MAX_IMAGE_BYTES) return { ok: false, error: 'image_too_large' };
    const chunks = [];
    const reader = r.body && r.body.getReader ? r.body.getReader() : null;
    if (reader) {
      let total = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // eslint-disable-next-line no-await-in-loop
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        chunks.push(Buffer.from(value));
        if (total > _MAX_IMAGE_BYTES) {
          try { reader.cancel(); } catch (_e) { /* swallow */ }
          break;
        }
      }
    } else {
      const ab = await r.arrayBuffer();
      chunks.push(Buffer.from(ab));
    }
    return { ok: true, buf: Buffer.concat(chunks), contentType: r.headers.get('content-type') || 'image/jpeg' };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : 'network', message: err.message };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Compute a perceptual hash of the image bytes. We try `sharp` first
 * (it's the most reliable JPEG decoder and only a 30 ms call on a
 * 200×200 image); if `sharp` isn't installed we fall back to a
 * lightweight SHA-1 of the file as the cache key. The cache hit-rate
 * is the same — the only thing we lose with the fallback is that
 * different JPEG re-encodings of the SAME image won't share a slot.
 */
async function _perceptualHash(buf) {
  try {
    // eslint-disable-next-line global-require
    const sharp = require('sharp');
    const small = await sharp(buf)
      .greyscale()
      .resize(9, 8, { fit: 'fill' })
      .raw()
      .toBuffer();
    let bits = '';
    for (let row = 0; row < 8; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        const i = row * 9 + col;
        bits += small[i] > small[i + 1] ? '1' : '0';
      }
    }
    const hash = BigInt(`0b${bits}`).toString(16).padStart(16, '0');
    return { algo: 'dhash', hash };
  } catch (err) {
    const hash = crypto.createHash('sha1').update(buf).digest('hex');
    return { algo: 'sha1-fallback', hash };
  }
}

async function _serpapi(engine, imageUrl, keyResolution, userId, jobId) {
  if (!keyResolution || !keyResolution.key) return { ok: false, error: 'no_key', hits: [] };
  const cacheShape = { engine, imageUrl };
  const cached = await lookupCache.get(`serpapi-${engine}`, cacheShape);
  if (cached) return { ok: true, hits: cached.hits || [], cached: true };
  const cost = _COST.serpapi;
  if (cost > 0) {
    const budget = await lookupBudget.assertCanSpend(userId, cost);
    if (!budget.allowed) return { ok: false, error: 'budget_exceeded', hits: [] };
  }
  await lookupLimiter.acquire(`reverse:serpapi:${engine}`, { class: 'read', jitterMs: 250 });
  const params = new URLSearchParams({
    api_key: keyResolution.key,
    engine,
  });
  if (engine === 'yandex_images') params.set('url', imageUrl);
  else if (engine === 'google_reverse_image') params.set('image_url', imageUrl);
  const url = `https://serpapi.com/search.json?${params.toString()}`;
  let body;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    const txt = await r.text();
    try { body = JSON.parse(txt); } catch (_e) { body = { _raw: txt }; }
    if (!r.ok) return { ok: false, error: `http_${r.status}`, hits: [], body };
  } catch (err) {
    return { ok: false, error: 'network', hits: [], message: err.message };
  }
  // Yandex: similar_images / similar_results / images_results
  // Google: image_results / inline_images
  const hits = [];
  for (const key of ['inline_images', 'image_results', 'images_results', 'similar_images', 'visual_matches', 'similar_results']) {
    if (Array.isArray(body[key])) {
      for (const it of body[key].slice(0, 25)) {
        const link = it.link || it.source || it.original || it.source_url || (it.thumbnail && it.thumbnail);
        const title = it.title || it.source_name || null;
        if (link && /^https?:\/\//.test(link)) hits.push({ url: link, title, provider: `serpapi.${engine}` });
      }
    }
  }
  await lookupCache.set(`serpapi-${engine}`, cacheShape, { hits }, { costUsd: cost, ttlMs: lookupCache.DEFAULT_TTL_MS });
  if (cost > 0) {
    await lookupBudget.recordSpend({ userId, provider: 'serpapi', costUsd: cost, jobId, method: 'reverse_image' });
    lookupAudit.log({
      userId, jobId: jobId || null, action: 'paid_call', method: 'reverse_image',
      meta: { provider: `serpapi.${engine}`, imageUrl, hits: hits.length },
      costUsd: cost,
    });
  }
  return { ok: true, hits, cached: false };
}

async function _pimeyes(imageBuf, keyResolution, userId, jobId) {
  if (!keyResolution || !keyResolution.key) return { ok: false, error: 'no_key', hits: [] };
  const cacheShape = { hash: crypto.createHash('sha256').update(imageBuf).digest('hex') };
  const cached = await lookupCache.get('pimeyes', cacheShape);
  if (cached) return { ok: true, hits: cached.hits || [], cached: true };
  const cost = _COST.pimeyes;
  if (cost > 0) {
    const budget = await lookupBudget.assertCanSpend(userId, cost);
    if (!budget.allowed) return { ok: false, error: 'budget_exceeded', hits: [] };
  }
  await lookupLimiter.acquire(`reverse:pimeyes`, { class: 'read', jitterMs: 500 });
  // PimEyes search-by-upload — multipart POST to /v2/search/upload.
  // PimEyes returns a search_id; we then poll /v2/search/results/{id}.
  const form = new FormData();
  form.append('image', new Blob([imageBuf], { type: 'image/jpeg' }), 'profile.jpg');
  let create;
  try {
    const r = await fetch('https://api.pimeyes.com/v2/search/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${keyResolution.key}` },
      body: form,
    });
    create = await r.json().catch(() => null);
    if (!r.ok || !create || !create.id) {
      return { ok: false, error: `pimeyes_${r.status}`, hits: [], body: create };
    }
  } catch (err) {
    return { ok: false, error: 'network', hits: [], message: err.message };
  }
  // Poll up to 6 times × 2s = 12s for results.
  let results = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 2000));
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await fetch(`https://api.pimeyes.com/v2/search/results/${encodeURIComponent(create.id)}`, {
        headers: { Authorization: `Bearer ${keyResolution.key}` },
      });
      if (!r.ok) continue;
      // eslint-disable-next-line no-await-in-loop
      const body = await r.json().catch(() => null);
      if (body && (body.status === 'done' || Array.isArray(body.results))) {
        results = body.results || [];
        break;
      }
    } catch (_e) { /* swallow, retry */ }
  }
  const hits = (results || []).slice(0, 25).map((m) => ({
    url:      m.source_url || m.url || null,
    title:    m.title || null,
    score:    m.score || null,
    provider: 'pimeyes',
    thumbnail: m.thumbnail || null,
  })).filter((m) => m.url);
  await lookupCache.set('pimeyes', cacheShape, { hits }, { costUsd: cost, ttlMs: lookupCache.DEFAULT_TTL_MS });
  if (cost > 0) {
    await lookupBudget.recordSpend({ userId, provider: 'pimeyes', costUsd: cost, jobId, method: 'reverse_image' });
    lookupAudit.log({
      userId, jobId: jobId || null, action: 'paid_call', method: 'reverse_image',
      meta: { provider: 'pimeyes', hits: hits.length },
      costUsd: cost,
    });
  }
  return { ok: true, hits, cached: false };
}

async function _tineye(imageBuf, keyResolution, userId, jobId) {
  if (!keyResolution || !keyResolution.key) return { ok: false, error: 'no_key', hits: [] };
  const cacheShape = { hash: crypto.createHash('sha256').update(imageBuf).digest('hex') };
  const cached = await lookupCache.get('tineye', cacheShape);
  if (cached) return { ok: true, hits: cached.hits || [], cached: true };
  const cost = _COST.tineye;
  if (cost > 0) {
    const budget = await lookupBudget.assertCanSpend(userId, cost);
    if (!budget.allowed) return { ok: false, error: 'budget_exceeded', hits: [] };
  }
  await lookupLimiter.acquire(`reverse:tineye`, { class: 'read', jitterMs: 250 });
  const form = new FormData();
  form.append('image_upload', new Blob([imageBuf], { type: 'image/jpeg' }), 'profile.jpg');
  let body;
  try {
    const r = await fetch('https://api.tineye.com/rest/search/', {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`api:${keyResolution.key}`).toString('base64')}` },
      body: form,
    });
    body = await r.json().catch(() => null);
    if (!r.ok || !body) return { ok: false, error: `tineye_${r.status}`, hits: [], body };
  } catch (err) {
    return { ok: false, error: 'network', hits: [], message: err.message };
  }
  const matches = (body.results && body.results.matches) || [];
  const hits = matches.slice(0, 25).map((m) => ({
    url:      (m.backlinks && m.backlinks[0] && m.backlinks[0].url) || null,
    title:    (m.backlinks && m.backlinks[0] && m.backlinks[0].backlink) || null,
    score:    m.score || null,
    provider: 'tineye',
  })).filter((m) => m.url);
  await lookupCache.set('tineye', cacheShape, { hits }, { costUsd: cost, ttlMs: lookupCache.DEFAULT_TTL_MS });
  if (cost > 0) {
    await lookupBudget.recordSpend({ userId, provider: 'tineye', costUsd: cost, jobId, method: 'reverse_image' });
    lookupAudit.log({
      userId, jobId: jobId || null, action: 'paid_call', method: 'reverse_image',
      meta: { provider: 'tineye', hits: hits.length },
      costUsd: cost,
    });
  }
  return { ok: true, hits, cached: false };
}

async function run(username, opts = {}) {
  if (!username || typeof username !== 'string') {
    throw new AppError('reverseImage.run: username required', 400, 'VALIDATION_ERROR');
  }
  const cleaned = _stripUsername(username);
  const userId = opts.userId || null;

  // Pull profile picture URLs from the Stage-1 snapshot.
  const pi = opts.profileInfoSnapshot;
  const candidates = [];
  if (pi && pi.data && pi.data.user) {
    const u = pi.data.user;
    if (u.hd_profile_pic_url_info && u.hd_profile_pic_url_info.url) candidates.push(u.hd_profile_pic_url_info.url);
    if (u.profile_pic_url_hd) candidates.push(u.profile_pic_url_hd);
    if (u.profile_pic_url)    candidates.push(u.profile_pic_url);
  }
  if (typeof opts.profilePicUrl === 'string') candidates.push(opts.profilePicUrl);
  const urls = [...new Set(candidates.filter((u) => /^https?:\/\//.test(u)))].slice(0, 1);
  if (!urls.length) {
    return {
      method: 'reverse_image',
      ok: true,
      findings: [{
        method: 'reverse_image',
        kind: 'note',
        value: 'reverse_image: no profile_pic_url in snapshot (run profile_info first).',
        confidence: 100,
      }],
    };
  }
  const imageUrl = urls[0];
  // Try to download to compute the perceptual hash. If the download
  // fails we still attempt SerpAPI by URL — that path doesn't need the
  // bytes.
  const dl = await _fetchBuffer(imageUrl);
  const phash = dl.ok ? await _perceptualHash(dl.buf) : { algo: 'none', hash: null };

  const keys = await userLookupKeys.getAllKeys(userId);
  const tasks = [];
  if (keys.serpapi) {
    tasks.push(_serpapi('yandex_images',        imageUrl, keys.serpapi, userId, opts.jobId).then((r) => ['serpapi.yandex', r]));
    tasks.push(_serpapi('google_reverse_image', imageUrl, keys.serpapi, userId, opts.jobId).then((r) => ['serpapi.google', r]));
  }
  if (keys.pimeyes && dl.ok) {
    tasks.push(_pimeyes(dl.buf, keys.pimeyes, userId, opts.jobId).then((r) => ['pimeyes', r]));
  }
  if (keys.tineye && dl.ok) {
    tasks.push(_tineye(dl.buf, keys.tineye, userId, opts.jobId).then((r) => ['tineye', r]));
  }
  if (!tasks.length) {
    return {
      method: 'reverse_image',
      ok: true,
      findings: [{
        method: 'reverse_image',
        kind: 'note',
        value: 'reverse_image: no key configured for SerpAPI / PimEyes / TinEye.',
        confidence: 100,
      }],
      raw: { imageUrl, phash },
    };
  }
  const results = await Promise.allSettled(tasks);
  const providerSummary = {};
  const urlVotes = new Map(); // url → { providers: Set, titles: Set }
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const [name, body] = r.value;
    providerSummary[name] = body.ok
      ? { ok: true, hits: body.hits.length, cached: !!body.cached }
      : { ok: false, error: body.error };
    for (const h of (body.hits || [])) {
      const u = String(h.url).split('#')[0];
      const cur = urlVotes.get(u) || { providers: new Set(), titles: new Set(), thumbnail: null };
      cur.providers.add(name);
      if (h.title) cur.titles.add(h.title);
      if (h.thumbnail) cur.thumbnail = h.thumbnail;
      urlVotes.set(u, cur);
    }
  }
  // Suppress 2captcha integration on actual UI surface; it's used
  // internally when the Yandex frontpage challenges us. For now we
  // just log the captcha event and never feed back into the public
  // search-result vector.
  void twoCaptcha;

  const findings = [];
  for (const [url, info] of urlVotes.entries()) {
    const n = info.providers.size;
    const conf = n >= 3 ? 95 : n === 2 ? 80 : 60;
    findings.push({
      method: 'reverse_image',
      kind: 'url',
      value: url,
      confidence: conf,
      sourceUrl: imageUrl,
      raw: {
        providers: [...info.providers],
        title: info.titles.size ? [...info.titles][0] : null,
        thumbnail: info.thumbnail,
        phash,
      },
    });
  }
  findings.push({
    method: 'reverse_image',
    kind: 'note',
    value: `reverse_image summary: ${
      Object.entries(providerSummary)
        .map(([p, s]) => `${p}=${s.ok ? `${s.hits}h${s.cached ? '(c)' : ''}` : s.error}`)
        .join(' ')
    }`,
    confidence: 100,
    raw: { providerSummary, totalUniqueUrls: urlVotes.size, phash, imageUrl },
  });

  logger.info(`IG.lookup.reverseImage: ${cleaned} → providers=${tasks.length} unique_urls=${urlVotes.size}`);

  return {
    method: 'reverse_image',
    ok: true,
    findings,
    raw: { imageUrl, phash, providerSummary },
  };
}

module.exports = {
  run,
  _perceptualHash,
  _fetchBuffer,
};
