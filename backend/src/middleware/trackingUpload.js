const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { AppError } = require('../utils/errorHandler');

const uploadDir = path.join(__dirname, '../../uploads');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userId = req.user?.id || 'anonymous';
    const accountId = req.params?.id || 'unassigned';
    const dir = path.join(uploadDir, String(userId), 'tracking', String(accountId));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${uuidv4()}${path.extname(file.originalname)}`);
  },
});

// Broader whitelist than middleware/upload.js — tracking attachments
// include screenshots and documents in addition to session/backup files.
const fileFilter = (req, file, cb) => {
  const allowedExtensions = /\.(session|json|bin|zip|png|jpe?g|webp|gif|pdf|docx?|xlsx|csv|txt)$/i;
  const allowedMimeTypes = [
    'application/octet-stream', 'application/json', 'text/plain', 'text/csv',
    'application/zip', 'application/x-zip', 'application/x-zip-compressed', 'multipart/x-zip',
    'image/png', 'image/jpeg', 'image/webp', 'image/gif',
    'application/pdf', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ];
  if (allowedExtensions.test(file.originalname) || allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new AppError(
      'Invalid file type. Allowed: .session, .json, .bin, .zip, images, .pdf, .doc(x), .csv, .txt',
      400,
      'INVALID_FILE_TYPE'
    ), false);
  }
};

const upload = multer({
  storage,
  limits: {
    fileSize: parseInt(process.env.MAX_UPLOAD_SIZE) * 1024 * 1024 || 500 * 1024 * 1024,
    files: 10,
  },
  fileFilter,
});

const uploadTrackingFile = (fieldName = 'file') => upload.single(fieldName);

module.exports = {
  uploadTrackingFile,
  uploadDir,
};
