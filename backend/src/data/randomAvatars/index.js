/**
 * Catalog of bundled avatar images that the "Randomize Mode" and "Apply
 * Profile List" features sample from.
 *
 * The catalog is built by scanning the avatar directory at module-load
 * time so dropping additional `avatar*.{png,jpg,jpeg}` files automatically
 * extends the pool with no code change.
 *
 * The pool today contains:
 *   - 158 stylised real-looking avatars (anime portraits, illustrated
 *     heroes, robots, cartoons, pixel art, etc.) seeded via DiceBear and
 *     committed as `avatar001.png … avatar158.png`.
 *   - 12 legacy `avatarNN.jpg` placeholders kept for backward
 *     compatibility with any URL the frontend may have cached.
 *
 * Avatars are sorted alphabetically (so iteration order is stable) and
 * the helpers below resolve an avatar ID to its on-disk path regardless
 * of extension.
 */

const path = require('path');
const fs = require('fs');

const AVATAR_DIR = __dirname;

/**
 * Scan the avatar directory and produce `{ id, fileName, absPath }`
 * tuples for every supported image. The `id` is the basename without
 * extension (`avatar001` for `avatar001.png`).
 */
function scanAvatars() {
  let names;
  try {
    names = fs.readdirSync(AVATAR_DIR);
  } catch (err) {
    return [];
  }
  const matches = names
    .filter((name) => /^avatar[\w-]+\.(png|jpg|jpeg)$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  return matches.map((fileName) => {
    const ext = path.extname(fileName);
    const id = path.basename(fileName, ext);
    return {
      id,
      fileName,
      absPath: path.join(AVATAR_DIR, fileName),
    };
  });
}

const _CATALOG = scanAvatars();
const _BY_ID = new Map(_CATALOG.map((entry) => [entry.id, entry]));

/**
 * Frozen list of canonical avatar IDs in sort order.
 */
const AVATAR_IDS = Object.freeze(_CATALOG.map((entry) => entry.id));

/**
 * Returns the avatar catalog as plain `{id, fileName, absPath}` records.
 */
function getAvatars() {
  return _CATALOG.map((entry) => ({ ...entry }));
}

/**
 * Resolve an avatar ID to its on-disk path. Returns null if the ID is
 * unknown OR the underlying file has gone missing (which would be a
 * deploy bug, not a runtime concern).
 */
function resolveAvatarPath(id) {
  if (!id || typeof id !== 'string') return null;
  const entry = _BY_ID.get(id);
  if (!entry) return null;
  if (!fs.existsSync(entry.absPath)) return null;
  return entry.absPath;
}

module.exports = {
  AVATAR_IDS,
  AVATAR_DIR,
  getAvatars,
  resolveAvatarPath,
};
