/**
 * storyUpload — express-fileupload configured for story media.
 *
 * Stories accept photos and short videos. Videos are much larger than
 * profile photos, so this uses a 50MB cap (well above typical vertical
 * story clips) and streams to a temp file instead of buffering the whole
 * upload in memory.
 */

const os = require('os');
const path = require('path');
const expressFileUpload = require('express-fileupload');

module.exports = expressFileUpload({
  limits: {
    fileSize: parseInt(process.env.STORY_MAX_UPLOAD_BYTES || String(50 * 1024 * 1024), 10),
  },
  abortOnLimit: true,
  useTempFiles: true,
  tempFileDir: path.join(os.tmpdir(), 'telegram-panel', 'story-upload-tmp'),
  createParentPath: true,
});
