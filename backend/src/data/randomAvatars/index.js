/**
 * Catalog of bundled avatar JPGs that the "Randomize" feature samples from.
 *
 * Files live next to this module in `./avatar01.jpg … avatar12.jpg`. Add more
 * by dropping additional `avatarNN.jpg` files in this directory and listing
 * their IDs below.
 */

const path = require('path');
const fs = require('fs');

const AVATAR_DIR = __dirname;

const AVATAR_IDS = [
  'avatar01', 'avatar02', 'avatar03', 'avatar04',
  'avatar05', 'avatar06', 'avatar07', 'avatar08',
  'avatar09', 'avatar10', 'avatar11', 'avatar12',
];

function getAvatars() {
  return AVATAR_IDS.map((id) => ({
    id,
    fileName: `${id}.jpg`,
    absPath: path.join(AVATAR_DIR, `${id}.jpg`),
  }));
}

function resolveAvatarPath(id) {
  if (!id || typeof id !== 'string') return null;
  if (!AVATAR_IDS.includes(id)) return null;
  const absPath = path.join(AVATAR_DIR, `${id}.jpg`);
  if (!fs.existsSync(absPath)) return null;
  return absPath;
}

module.exports = {
  AVATAR_IDS,
  AVATAR_DIR,
  getAvatars,
  resolveAvatarPath,
};
