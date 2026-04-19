const expressFileUpload = require('express-fileupload');

// Configure express-fileupload middleware
const fileUpload = expressFileUpload({
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max file size
  },
  abortOnLimit: true,
  useTempFiles: false,
});

module.exports = fileUpload;
