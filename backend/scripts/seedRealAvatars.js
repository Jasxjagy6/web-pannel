#!/usr/bin/env node
/**
 * Seed `backend/src/data/randomAvatars/` with a pool of REAL human photos
 * used as random Telegram profile pictures by the "Randomize Mode" and
 * "Apply Profile List" features.
 *
 * Why this script exists in its current form (2026-05-13 incident):
 *   The previous revision seeded 200 portraits from randomuser.me alongside
 *   ~45 Wikimedia actor portraits. randomuser.me only ships 128x128 images,
 *   which Telegram rejects on every `photos.UploadProfilePhoto` with
 *   `PHOTO_CROP_SIZE_SMALL` (Telegram floor is ~160 on the smallest side).
 *   That meant 83% of the bundled avatars were unusable.
 *
 *   This revision:
 *     - DROPS randomuser.me entirely (no images >128px are exposed).
 *     - Pulls a much wider list of REAL HUMAN portraits from
 *       Wikimedia Commons via the MediaWiki `pageimages` API:
 *         * Live-action superhero actors (MCU / DC / X-Men) — kept.
 *         * Other Hollywood A-listers — added.
 *         * Bollywood A-listers — added.
 *         * South Indian (Tamil / Telugu) cinema stars — added.
 *     - Requests a 1024px thumbnail (`pithumbsize=1024`) so even the
 *       smaller-side dimension is comfortably above Telegram's floor.
 *     - REJECTS any downloaded image where MIN(width, height) < 320,
 *       so a stray low-resolution Wikipedia thumbnail can't sneak back
 *       into the pool. Telegram's actual floor is ~160; we keep the
 *       validator at 320 as a healthy safety margin.
 *
 *  No cartoon / anime / stylised art ever enters this pool — every
 *  source URL is a Wikipedia article for a real, photographed person.
 *
 * Usage:
 *   node backend/scripts/seedRealAvatars.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const sizeOf = require('image-size');

const OUT_DIR = path.resolve(__dirname, '..', 'src', 'data', 'randomAvatars');
const USER_AGENT =
  'WebPannelAvatarBot/1.0 (https://github.com/Jasxjagy6/web-pannel; harjagy@outlook.com)';

const THUMB_SIZE = 1024; // maximum thumbnail dimension requested from MediaWiki
const MIN_SHORT_SIDE = 320; // reject anything below this on the smaller side

// ---------------------------------------------------------------------------
// Real-human portraits. Each entry is [wikipediaArticleTitle, displayLabel].
// We resolve the article's lead `pageimage` through the MediaWiki API to get
// a direct CDN thumbnail URL — way more robust than guessing exact file
// names (Wikipedia re-uploads with new versions frequently).
//
// Every name on these lists is a real, living/historical human being. No
// fictional characters, no cartoons, no anime, no AI-generated faces.
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

const HOLLYWOOD_ACTORS = [
  // — Male leads —
  ['Tom_Cruise', 'Hollywood'],
  ['Brad_Pitt', 'Hollywood'],
  ['Leonardo_DiCaprio', 'Hollywood'],
  ['Will_Smith', 'Hollywood'],
  ['Denzel_Washington', 'Hollywood'],
  ['Morgan_Freeman', 'Hollywood'],
  ['Tom_Hanks', 'Hollywood'],
  ['Johnny_Depp', 'Hollywood'],
  ['Keanu_Reeves', 'Hollywood'],
  ['Matt_Damon', 'Hollywood'],
  ['Robert_De_Niro', 'Hollywood'],
  ['Al_Pacino', 'Hollywood'],
  ['George_Clooney', 'Hollywood'],
  ['Daniel_Craig', 'Hollywood'],
  ['Ewan_McGregor', 'Hollywood'],
  ['Liam_Neeson', 'Hollywood'],
  ['Russell_Crowe', 'Hollywood'],
  ['Christoph_Waltz', 'Hollywood'],
  ['Idris_Elba', 'Hollywood'],
  ['Adam_Driver', 'Hollywood'],
  ['Jake_Gyllenhaal', 'Hollywood'],
  ['Ryan_Gosling', 'Hollywood'],
  ['Michael_B._Jordan', 'Hollywood'],
  ['Mahershala_Ali', 'Hollywood'],
  ['Cillian_Murphy', 'Hollywood'],
  ['Pedro_Pascal', 'Hollywood'],
  ['Timothée_Chalamet', 'Hollywood'],
  ['Jesse_Eisenberg', 'Hollywood'],
  ['Eddie_Redmayne', 'Hollywood'],
  ['Tom_Hardy', 'Hollywood'],
  ['John_Boyega', 'Hollywood'],
  ['Daniel_Kaluuya', 'Hollywood'],
  ['Lakeith_Stanfield', 'Hollywood'],
  ['Donald_Glover', 'Hollywood'],
  // — Female leads —
  ['Jennifer_Aniston', 'Hollywood'],
  ['Angelina_Jolie', 'Hollywood'],
  ['Julia_Roberts', 'Hollywood'],
  ['Sandra_Bullock', 'Hollywood'],
  ['Charlize_Theron', 'Hollywood'],
  ['Cate_Blanchett', 'Hollywood'],
  ['Anne_Hathaway', 'Hollywood'],
  ['Nicole_Kidman', 'Hollywood'],
  ['Natalie_Portman', 'Hollywood'],
  ['Emma_Stone', 'Hollywood'],
  ['Emma_Watson', 'Hollywood'],
  ['Jennifer_Lopez', 'Hollywood'],
  ['Halle_Berry', 'Hollywood'],
  ['Reese_Witherspoon', 'Hollywood'],
  ['Drew_Barrymore', 'Hollywood'],
  ['Salma_Hayek', 'Hollywood'],
  ['Penélope_Cruz', 'Hollywood'],
  ['Monica_Bellucci', 'Hollywood'],
  ['Zendaya', 'Hollywood'],
  ['Lupita_Nyong\'o', 'Hollywood'],
  ['Saoirse_Ronan', 'Hollywood'],
  ['Margot_Robbie', 'Hollywood'], // also in superhero list, dedup later
  ['Anya_Taylor-Joy', 'Hollywood'],
  ['Sydney_Sweeney', 'Hollywood'],
  ['Florence_Pugh', 'Hollywood'], // dup, dedup later
  ['Millie_Bobby_Brown', 'Hollywood'],
  ['Viola_Davis', 'Hollywood'],
  ['Octavia_Spencer', 'Hollywood'],
  ['Kerry_Washington', 'Hollywood'],
  ['Gugu_Mbatha-Raw', 'Hollywood'],
];

const BOLLYWOOD_ACTORS = [
  // — Male leads —
  ['Shah_Rukh_Khan', 'Bollywood'],
  ['Salman_Khan', 'Bollywood'],
  ['Aamir_Khan', 'Bollywood'],
  ['Hrithik_Roshan', 'Bollywood'],
  ['Akshay_Kumar', 'Bollywood'],
  ['Ranbir_Kapoor', 'Bollywood'],
  ['Ranveer_Singh', 'Bollywood'],
  ['Amitabh_Bachchan', 'Bollywood'],
  ['Vicky_Kaushal', 'Bollywood'],
  ['Saif_Ali_Khan', 'Bollywood'],
  ['Ayushmann_Khurrana', 'Bollywood'],
  ['Rajkummar_Rao', 'Bollywood'],
  ['Varun_Dhawan', 'Bollywood'],
  ['Sidharth_Malhotra', 'Bollywood'],
  ['Tiger_Shroff', 'Bollywood'],
  ['Sushant_Singh_Rajput', 'Bollywood'],
  ['Pankaj_Tripathi', 'Bollywood'],
  ['Irrfan_Khan', 'Bollywood'],
  ['Nawazuddin_Siddiqui', 'Bollywood'],
  ['Manoj_Bajpayee', 'Bollywood'],
  ['Abhishek_Bachchan', 'Bollywood'],
  ['Arjun_Kapoor', 'Bollywood'],
  ['Kartik_Aaryan', 'Bollywood'],
  ['Anil_Kapoor', 'Bollywood'],
  ['Boman_Irani', 'Bollywood'],
  ['Naseeruddin_Shah', 'Bollywood'],
  ['Paresh_Rawal', 'Bollywood'],
  // — Female leads —
  ['Deepika_Padukone', 'Bollywood'],
  ['Priyanka_Chopra', 'Bollywood'],
  ['Aishwarya_Rai_Bachchan', 'Bollywood'],
  ['Katrina_Kaif', 'Bollywood'],
  ['Alia_Bhatt', 'Bollywood'],
  ['Anushka_Sharma', 'Bollywood'],
  ['Kareena_Kapoor_Khan', 'Bollywood'],
  ['Madhuri_Dixit', 'Bollywood'],
  ['Vidya_Balan', 'Bollywood'],
  ['Kangana_Ranaut', 'Bollywood'],
  ['Tabu_(actress)', 'Bollywood'],
  ['Sonam_Kapoor', 'Bollywood'],
  ['Jacqueline_Fernandez', 'Bollywood'],
  ['Bhumi_Pednekar', 'Bollywood'],
  ['Kiara_Advani', 'Bollywood'],
  ['Shraddha_Kapoor', 'Bollywood'],
  ['Disha_Patani', 'Bollywood'],
  ['Sara_Ali_Khan', 'Bollywood'],
  ['Janhvi_Kapoor', 'Bollywood'],
  ['Kriti_Sanon', 'Bollywood'],
  ['Parineeti_Chopra', 'Bollywood'],
  ['Yami_Gautam', 'Bollywood'],
  ['Taapsee_Pannu', 'Bollywood'],
  ['Radhika_Apte', 'Bollywood'],
  ['Konkona_Sen_Sharma', 'Bollywood'],
];

const SOUTH_INDIAN_ACTORS = [
  ['Rajinikanth', 'South Indian'],
  ['Kamal_Haasan', 'South Indian'],
  ['Allu_Arjun', 'South Indian'],
  ['Prabhas', 'South Indian'],
  ['Mahesh_Babu', 'South Indian'],
  ['Ram_Charan', 'South Indian'],
  ['N._T._Rama_Rao_Jr.', 'South Indian'],
  ['Vijay_(actor)', 'South Indian'],
  ['Suriya', 'South Indian'],
  ['Dhanush', 'South Indian'],
  ['Mohanlal', 'South Indian'],
  ['Mammootty', 'South Indian'],
  ['Fahadh_Faasil', 'South Indian'],
  ['Yash_(actor)', 'South Indian'],
  ['Vijay_Sethupathi', 'South Indian'],
  ['Vikram_(actor)', 'South Indian'],
  ['Nayanthara', 'South Indian'],
  ['Samantha_Ruth_Prabhu', 'South Indian'],
  ['Trisha_Krishnan', 'South Indian'],
  ['Rashmika_Mandanna', 'South Indian'],
  ['Pooja_Hegde', 'South Indian'],
  ['Sai_Pallavi', 'South Indian'],
  ['Keerthy_Suresh', 'South Indian'],
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
          // Follow one redirect
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

async function resolveWikipediaPageImage(articleTitle, width = THUMB_SIZE) {
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

function imageDimensions(buf) {
  try {
    return sizeOf(buf);
  } catch (_) {
    return null;
  }
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

async function withRetry(fn, label, tries = 5) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const is429 = /HTTP 429/.test((err && err.message) || '');
      // Exponential-ish backoff. Wikipedia rate-limits aggressively on
      // upload.wikimedia.org; back off much harder on 429 specifically.
      const baseMs = is429 ? 4000 : 600;
      const waitMs = baseMs * (i + 1);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw new Error(`${label} failed after ${tries} tries: ${lastErr && lastErr.message}`);
}

async function main() {
  const wiped = wipeExistingAvatars();
  console.log(`Wiped ${wiped} existing avatar files in ${OUT_DIR}`);

  // De-duplicate articles across the four lists (Margot Robbie / Florence Pugh
  // appear in both the superhero and Hollywood lists).
  const allArticles = [
    ...SUPERHERO_ACTORS.map(([a, role]) => ({ article: a, group: 'Superhero', role })),
    ...HOLLYWOOD_ACTORS.map(([a, role]) => ({ article: a, group: role, role })),
    ...BOLLYWOOD_ACTORS.map(([a, role]) => ({ article: a, group: role, role })),
    ...SOUTH_INDIAN_ACTORS.map(([a, role]) => ({ article: a, group: role, role })),
  ];
  const seen = new Set();
  const articles = [];
  for (const entry of allArticles) {
    if (seen.has(entry.article)) continue;
    seen.add(entry.article);
    articles.push(entry);
  }

  console.log(
    `Resolving ${articles.length} unique Wikipedia article pageimages ` +
      `(superhero=${SUPERHERO_ACTORS.length}, hollywood=${HOLLYWOOD_ACTORS.length}, ` +
      `bollywood=${BOLLYWOOD_ACTORS.length}, south=${SOUTH_INDIAN_ACTORS.length})…`
  );

  const sources = [];
  for (const entry of articles) {
    try {
      const url = await withRetry(
        () => resolveWikipediaPageImage(entry.article, THUMB_SIZE),
        `resolve ${entry.article}`,
        3
      );
      sources.push({ url, title: `${entry.article} (${entry.role})`, group: entry.group });
    } catch (err) {
      console.warn(`  skipping ${entry.article}: ${err.message}`);
    }
  }

  console.log(`Downloading ${sources.length} images…`);

  let saved = 0;
  let failed = 0;
  let rejectedTooSmall = 0;
  for (const src of sources) {
    try {
      const { buf, ext } = await withRetry(() => downloadOne(src.url), src.url, 3);

      const dims = imageDimensions(buf);
      if (!dims || !dims.width || !dims.height) {
        failed += 1;
        console.warn(`  could not read dimensions: ${src.url}`);
        continue;
      }
      const shortSide = Math.min(dims.width, dims.height);
      if (shortSide < MIN_SHORT_SIDE) {
        rejectedTooSmall += 1;
        console.warn(
          `  REJECT (too small ${dims.width}x${dims.height}): ${src.title}`
        );
        continue;
      }

      const idx = saved + 1; // 1-based, contiguous numbering
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
    // Gentle pacing so we don't get rate-limited mid-run. Wikipedia's
    // upload CDN starts returning HTTP 429 around ~5 RPS; 750ms gives us
    // ~1.3 RPS with plenty of headroom.
    await new Promise((r) => setTimeout(r, 750));
  }

  console.log(
    `Done. Saved ${saved} avatars ` +
      `(failures: ${failed}, rejected-too-small: ${rejectedTooSmall}). Output: ${OUT_DIR}`
  );
}

main().catch((err) => {
  console.error('seedRealAvatars failed:', err);
  process.exit(1);
});
