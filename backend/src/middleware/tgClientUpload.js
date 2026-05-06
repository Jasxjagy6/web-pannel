/**
 * Multer middleware for the in-panel Telegram client's media-send routes.
 *
 * Stored under uploads/<userId>/tg-client/<uuid><ext> so the regular
 * session-upload directory (uploads/<userId>/) stays clean. Files are
 * removed by the controller after the GramJS upload completes (or on
 * failure) so the disk doesn't accumulate forever.
 *
 * Telegram's hard cap is 2 GB but the panel runs behind a reverse
 * proxy with smaller body limits in many deployments; the default 100 MB
 * cap below covers most chat scenarios (photo/video/audio/file) without
 * tripping reverse-proxy bodysize caps. Operators can raise it via
 * TG_CLIENT_MAX_UPLOAD_MB.
 */

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const ROOT = path.join(__dirname, '../../uploads');

function _userDir(userId) {
  const dir = path.join(ROOT, String(userId || 'anon'), 'tg-client');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    cb(null, _userDir(req.user?.id));
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '') || '';
    cb(null, `${uuidv4()}${ext}`);
  },
});

const sizeMb = parseInt(process.env.TG_CLIENT_MAX_UPLOAD_MB, 10);
const limit = (Number.isFinite(sizeMb) && sizeMb > 0 ? sizeMb : 100) * 1024 * 1024;

const upload = multer({
  storage,
  limits: { fileSize: limit, files: 1 },
});

module.exports = {
  uploadFile: upload.single('file'),
  uploadVoice: upload.single('voice'),
  uploadPhoto: upload.single('photo'),
  rootDir: ROOT,
};
