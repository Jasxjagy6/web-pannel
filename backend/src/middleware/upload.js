const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { AppError } = require('../utils/errorHandler');

const uploadDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userId = req.user?.id || 'anonymous';
    const userUploadDir = path.join(uploadDir, String(userId));

    if (!fs.existsSync(userUploadDir)) {
      fs.mkdirSync(userUploadDir, { recursive: true });
    }

    cb(null, userUploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});

const fileFilter = (req, file, cb) => {
  const allowedExtensions = /\.(session|json|bin|csv|txt)$/i;
  const allowedMimeTypes = [
    'application/octet-stream',
    'application/json',
    'text/plain',
    'text/csv',
  ];

  if (allowedExtensions.test(file.originalname) || allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new AppError('Invalid file type. Allowed: .session, .json, .bin, .csv, .txt', 400, 'INVALID_FILE_TYPE'), false);
  }
};

const upload = multer({
  storage,
  limits: {
    fileSize: parseInt(process.env.MAX_UPLOAD_SIZE) * 1024 * 1024 || 500 * 1024 * 1024,
    files: 1000,
  },
  fileFilter,
});

const uploadSingle = (fieldName = 'session') => {
  return upload.single(fieldName);
};

const uploadMultiple = (fieldName = 'sessions', maxCount = 1000) => {
  return upload.array(fieldName, maxCount);
};

const uploadFields = (fields) => {
  return upload.fields(fields);
};

module.exports = {
  uploadSingle,
  uploadMultiple,
  uploadFields,
  uploadDir,
};
