const rateLimit = require('express-rate-limit');
const { AppError } = require('../utils/errorHandler');

const generalLimiter = rateLimit({
  windowMs: (parseInt(process.env.RATE_LIMIT_WINDOW) || 15) * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 500,
  message: {
    success: false,
    error: {
      message: 'Too many requests, please try again later',
      code: 'RATE_LIMITED',
    },
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.user?.id || req.ip;
  },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: {
    success: false,
    error: {
      message: 'Too many authentication attempts, please try again later',
      code: 'AUTH_RATE_LIMITED',
    },
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 100,
  message: {
    success: false,
    error: {
      message: 'Upload limit reached, please try again later',
      code: 'UPLOAD_RATE_LIMITED',
    },
  },
});

const messageLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 50,
  message: {
    success: false,
    error: {
      message: 'Too many message jobs, please wait before creating more',
      code: 'MESSAGE_RATE_LIMITED',
    },
  },
});

const scrapeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 50,
  message: {
    success: false,
    error: {
      message: 'Scrape limit reached, please try again later',
      code: 'SCRAPE_RATE_LIMITED',
    },
  },
});

const createCustomLimiter = (options = {}) => {
  return rateLimit({
    windowMs: options.windowMs || 15 * 60 * 1000,
    max: options.max || 100,
    message: options.message || {
      success: false,
      error: {
        message: 'Too many requests',
        code: 'RATE_LIMITED',
      },
    },
    keyGenerator: options.keyGenerator || ((req) => req.user?.id || req.ip),
  });
};

module.exports = {
  generalLimiter,
  authLimiter,
  uploadLimiter,
  messageLimiter,
  scrapeLimiter,
  createCustomLimiter,
};
