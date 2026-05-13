#!/usr/bin/env node
/**
 * seedRandomAvatars.js
 *
 * Generates the bundled profile-picture catalog used by Account Settings →
 * Randomize / Apply-Profile-List. Pulls 150+ unique avatars from DiceBear
 * (CC0 licensed) spanning multiple styles so the panel can hand each
 * session a different, real-looking picture instead of two-letter initials.
 *
 *   Style buckets (deliberately diverse so no two sessions look alike):
 *     - lorelei         anime-style portraits
 *     - adventurer      illustrated hero/cartoon characters
 *     - avataaars       clean Bitmoji-style avatars
 *     - bottts          friendly robot faces
 *     - personas        illustrated personas / actors-in-character
 *     - notionists      Notion-style portraits
 *     - croodles        loose cartoon doodles
 *     - fun-emoji       cartoon emoji faces
 *     - pixel-art       pixel-art hero portraits
 *
 * Saves PNGs at 512×512 into `backend/src/data/randomAvatars/`.
 *
 * Usage:
 *   node backend/scripts/seedRandomAvatars.js            # full run
 *   node backend/scripts/seedRandomAvatars.js --force    # re-download even if file exists
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT_DIR = path.join(__dirname, '..', 'src', 'data', 'randomAvatars');
const DICEBEAR_BASE = 'https://api.dicebear.com/9.x';
const SIZE = 512;
const FORCE = process.argv.includes('--force');

// One curated seed list per style — each entry produces a unique avatar.
// Bucket sizes are tuned so the total is 156 (>=150 with comfortable margin).
const BUCKETS = [
  { style: 'lorelei', count: 22 },         // anime girls/boys
  { style: 'adventurer', count: 22 },      // adventure/hero characters
  { style: 'avataaars', count: 22 },       // Bitmoji-style
  { style: 'bottts', count: 16 },          // robots
  { style: 'personas', count: 18 },        // illustrated personas
  { style: 'notionists', count: 16 },      // Notion-style
  { style: 'croodles', count: 14 },        // cartoon doodles
  { style: 'fun-emoji', count: 14 },       // emoji faces
  { style: 'pixel-art', count: 14 },       // pixel-art heroes
];

function seedTokens(prefix, count) {
  return Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`);
}

function downloadOne(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const req = https.get(url, { headers: { 'User-Agent': 'web-pannel/avatar-seed' } }, (res) => {
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(destPath); } catch (_) {}
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    req.on('error', (err) => {
      file.close();
      try { fs.unlinkSync(destPath); } catch (_) {}
      reject(err);
    });
    req.setTimeout(25000, () => req.destroy(new Error('Timeout')));
  });
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const tasks = [];
  let idx = 0;
  for (const bucket of BUCKETS) {
    const seeds = seedTokens(bucket.style, bucket.count);
    for (const seed of seeds) {
      idx += 1;
      const id = `avatar${String(idx).padStart(3, '0')}`;
      const dest = path.join(OUT_DIR, `${id}.png`);
      const url = `${DICEBEAR_BASE}/${bucket.style}/png?seed=${encodeURIComponent(seed)}&size=${SIZE}`;
      tasks.push({ id, dest, url, style: bucket.style });
    }
  }

  console.log(`Seeding ${tasks.length} avatars to ${OUT_DIR}`);

  let ok = 0;
  let skipped = 0;
  let failed = 0;
  // Mild parallelism — 8 concurrent — to be friendly to the DiceBear API.
  const CONC = 8;
  let cursor = 0;
  const workers = Array.from({ length: CONC }, async () => {
    while (cursor < tasks.length) {
      const t = tasks[cursor++];
      if (!FORCE && fs.existsSync(t.dest) && fs.statSync(t.dest).size > 1024) {
        skipped += 1;
        continue;
      }
      try {
        await downloadOne(t.url, t.dest);
        const size = fs.statSync(t.dest).size;
        if (size < 1024) throw new Error(`File too small (${size} bytes)`);
        ok += 1;
        if (ok % 25 === 0) console.log(`  ${ok}/${tasks.length} downloaded`);
      } catch (err) {
        failed += 1;
        console.warn(`  FAIL ${t.id} (${t.style}): ${err.message}`);
      }
    }
  });
  await Promise.all(workers);

  console.log(`\nDone: ok=${ok}, skipped=${skipped}, failed=${failed}, total=${tasks.length}`);
  if (failed > 0) process.exitCode = 2;
}

main().catch((err) => {
  console.error('Fatal error during avatar seed:', err);
  process.exit(1);
});
