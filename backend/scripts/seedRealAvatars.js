#!/usr/bin/env node
/**
 * Seed `backend/src/data/randomAvatars/` with a pool of REAL human photos
 * used as random Telegram profile pictures by the "Randomize Mode" and
 * "Apply Profile List" features.
 *
 * Sources:
 *   - randomuser.me — Creative Commons / Flickr-sourced real portraits
 *     (men 0..99 + women 0..99 → 200 images).
 *   - upload.wikimedia.org — Wikimedia Commons portraits of well-known
 *     actors who play live-action superhero roles (Iron Man, Spider-Man,
 *     Captain America, etc.). Resolved through the MediaWiki API to get
 *     the canonical thumbnail URL.
 *
 * The script wipes any existing `avatar*.png` / `avatar*.jpg` files in
 * the output directory, then downloads the new pool with sequential
 * filenames `avatar001.jpg … avatarNNN.jpg`. The avatar index scanner
 * in `src/data/randomAvatars/index.js` picks them up automatically.
 *
 * Usage:
 *   node backend/scripts/seedRealAvatars.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT_DIR = path.resolve(__dirname, '..', 'src', 'data', 'randomAvatars');
const USER_AGENT =
  'WebPannelAvatarBot/1.0 (https://github.com/Jasxjagy6/web-pannel; harjagy@outlook.com)';

// ---------------------------------------------------------------------------
// Live-action superhero actors. Each entry is the Wikipedia article title for
// the actor; we resolve the article's lead `pageimage` via the MediaWiki API
// to get a direct CDN thumbnail URL. This is way more robust than guessing
// exact file names (Wikipedia re-uploads with new versions all the time).
// ---------------------------------------------------------------------------
const SUPERHERO_ACTORS = [
  // — MCU —
  ['Robert_Downey_Jr.', 'Iron Man'],
  ['Chris_Evans_(actor)', 'Captain America'],
  ['Chris_Hemsworth', 'Thor'],
  ['Mark_Ruffalo', 'Hulk'],
  ['Scarlett_Johansson', 'Black Widow'],
  ['Jeremy_Renner', 'Hawkeye'],
  ['Tom_Holland', 'Spider-Man'],
  ['Andrew_Garfield', 'Spider-Man'],
  ['Tobey_Maguire', 'Spider-Man'],
  ['Benedict_Cumberbatch', 'Doctor Strange'],
  ['Chadwick_Boseman', 'Black Panther'],
  ['Brie_Larson', 'Captain Marvel'],
  ['Paul_Rudd', 'Ant-Man'],
  ['Evangeline_Lilly', 'Wasp'],
  ['Tom_Hiddleston', 'Loki'],
  ['Anthony_Mackie', 'Falcon'],
  ['Sebastian_Stan', 'Winter Soldier'],
  ['Letitia_Wright', 'Shuri'],
  ['Zoe_Saldaña', 'Gamora'],
  ['Karen_Gillan', 'Nebula'],
  ['Chris_Pratt', 'Star-Lord'],
  ['Dave_Bautista', 'Drax'],
  ['Bradley_Cooper', 'Rocket'],
  ['Vin_Diesel', 'Groot'],
  ['Simu_Liu', 'Shang-Chi'],
  ['Oscar_Isaac', 'Moon Knight'],
  ['Hailee_Steinfeld', 'Kate Bishop'],
  ['Florence_Pugh', 'Yelena Belova'],
  ['Elizabeth_Olsen', 'Scarlet Witch'],
  // — Fox X-Men / Sony —
  ['Hugh_Jackman', 'Wolverine'],
  ['Ryan_Reynolds', 'Deadpool'],
  ['James_McAvoy', 'Professor X'],
  ['Michael_Fassbender', 'Magneto'],
  ['Jennifer_Lawrence', 'Mystique'],
  // — DCEU / DC —
  ['Henry_Cavill', 'Superman'],
  ['Gal_Gadot', 'Wonder Woman'],
  ['Ben_Affleck', 'Batman'],
  ['Robert_Pattinson', 'Batman'],
  ['Christian_Bale', 'Batman'],
  ['Jason_Momoa', 'Aquaman'],
  ['Ezra_Miller', 'Flash'],
  ['Zachary_Levi', 'Shazam'],
  ['Margot_Robbie', 'Harley Quinn'],
  ['Joaquin_Phoenix', 'Joker'],
  ['Heath_Ledger', 'Joker'],
];

function httpGetBuffer(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: opts.accept || 'image/*,*/*',
        },
      },
      (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          // Follow one redirect (pravatar.cc → unsplash CDN, etc.)
          return resolve(httpGetBuffer(res.headers.location, opts));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error(`Timeout for ${url}`)));
  });
}

async function resolveWikipediaPageImage(articleTitle, width = 600) {
  const apiUrl =
    'https://en.wikipedia.org/w/api.php?action=query&titles=' +
    encodeURIComponent(articleTitle) +
    `&prop=pageimages&piprop=thumbnail&pithumbsize=${width}&format=json&formatversion=2&redirects=1`;
  const body = await httpGetBuffer(apiUrl, { accept: 'application/json' });
  const json = JSON.parse(body.toString('utf8'));
  const page = json && json.query && json.query.pages && json.query.pages[0];
  const src = page && page.thumbnail && page.thumbnail.source;
  if (!src) {
    throw new Error(`No pageimage for ${articleTitle}`);
  }
  return src.split('?')[0];
}

function looksLikeJpeg(buf) {
  return buf && buf.length > 200 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

function looksLikePng(buf) {
  return (
    buf &&
    buf.length > 200 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  );
}

function wipeExistingAvatars() {
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    return 0;
  }
  let n = 0;
  for (const name of fs.readdirSync(OUT_DIR)) {
    if (/^avatar[\w-]+\.(png|jpg|jpeg)$/i.test(name)) {
      fs.unlinkSync(path.join(OUT_DIR, name));
      n += 1;
    }
  }
  return n;
}

async function downloadOne(url) {
  const buf = await httpGetBuffer(url);
  if (!looksLikeJpeg(buf) && !looksLikePng(buf)) {
    throw new Error(`Not an image: ${url} (first bytes: ${buf.slice(0, 4).toString('hex')})`);
  }
  return { buf, ext: looksLikePng(buf) ? 'png' : 'jpg' };
}

async function withRetry(fn, label, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400 + 600 * i));
    }
  }
  throw new Error(`${label} failed after ${tries} tries: ${lastErr.message}`);
}

async function main() {
  const wiped = wipeExistingAvatars();
  console.log(`Wiped ${wiped} existing avatar files in ${OUT_DIR}`);

  const sources = [];

  // ── randomuser.me men 0..99 ────────────────────────────────────────────
  for (let i = 0; i < 100; i++) {
    sources.push({
      kind: 'randomuser_men',
      url: `https://randomuser.me/api/portraits/men/${i}.jpg`,
    });
  }

  // ── randomuser.me women 0..99 ──────────────────────────────────────────
  for (let i = 0; i < 100; i++) {
    sources.push({
      kind: 'randomuser_women',
      url: `https://randomuser.me/api/portraits/women/${i}.jpg`,
    });
  }

  // ── Wikipedia — live-action superhero actor pageimages ─────────────────
  console.log(`Resolving ${SUPERHERO_ACTORS.length} Wikipedia article pageimages…`);
  for (const [article, role] of SUPERHERO_ACTORS) {
    try {
      const url = await withRetry(
        () => resolveWikipediaPageImage(article, 600),
        `resolve ${article}`,
        3
      );
      sources.push({ kind: 'wiki_actor', url, title: `${article} (${role})` });
    } catch (err) {
      console.warn(`  skipping ${article}: ${err.message}`);
    }
  }

  console.log(`Downloading ${sources.length} images…`);

  let saved = 0;
  let failed = 0;
  for (const src of sources) {
    const idx = saved + 1; // 1-based
    try {
      const { buf, ext } = await withRetry(() => downloadOne(src.url), src.url, 3);
      const fileName = `avatar${String(idx).padStart(3, '0')}.${ext}`;
      const outPath = path.join(OUT_DIR, fileName);
      fs.writeFileSync(outPath, buf);
      saved += 1;
      if (saved % 25 === 0) {
        console.log(`  saved ${saved}/${sources.length}`);
      }
    } catch (err) {
      failed += 1;
      console.warn(`  failed: ${src.url} — ${err.message}`);
    }
    // gentle pacing so we don't get rate-limited mid-run
    await new Promise((r) => setTimeout(r, 50));
  }

  console.log(`Done. Saved ${saved} avatars (failures: ${failed}). Output: ${OUT_DIR}`);
}

main().catch((err) => {
  console.error('seedRealAvatars failed:', err);
  process.exit(1);
});
