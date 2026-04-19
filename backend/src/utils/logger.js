const winston = require('winston');
const path = require('path');
require('dotenv').config();

const logDir = path.join(__dirname, '../../logs');
const fs = require('fs');

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  transports: [
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      maxsize: 5242880,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(logDir, 'app.log'),
      maxsize: 5242880,
      maxFiles: 5,
    }),
  ],
});

// Always add console logging in development AND for debugging
logger.add(
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        return `${timestamp} [${level}]: ${message}${
          Object.keys(meta).length ? '\n' + JSON.stringify(meta, null, 2) : ''
        }`;
      })
    ),
  })
);

module.exports = logger;
