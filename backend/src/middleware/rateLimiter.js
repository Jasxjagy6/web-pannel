const rateLimit = require('express-rate-limit');
const { AppError } = require('../utils/errorHandler');

// In single-admin mode every authenticated request has req.user.id === 1,
// so keying on user id collapses every browser/tab/user that's signed in
// with the shared admin credentials into a single bucket. Bursty UI
// (polling, batch operations, multiple admins watching the panel at
// once) trips the limiter quickly and surfaces as a 429 toast that
// looks like a logout.
//
// Switching the key to `<ip>` (or `<ip>+<route>` for narrow limiters)
// makes each browser its own bucket while still rate-limiting abusive
// callers.
const ipKey = (req) => req.ip;

const generalLimiter = rateLimit({
  windowMs: (parseInt(process.env.RATE_LIMIT_WINDOW) || 15) * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 5000,
  message: {
    success: false,
    error: {
      message: 'Too many requests, please try again later',
      code: 'RATE_LIMITED',
    },
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  // Don't burn the bucket on health checks / static OPTIONS preflights.
  skip: (req) => req.method === 'OPTIONS' || req.path === '/health',
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX) || 50,
  message: {
    success: false,
    error: {
      message: 'Too many authentication attempts, please try again later',
      code: 'AUTH_RATE_LIMITED',
    },
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.UPLOAD_RATE_LIMIT_MAX) || 500,
  message: {
    success: false,
    error: {
      message: 'Upload limit reached, please try again later',
      code: 'UPLOAD_RATE_LIMITED',
    },
  },
  keyGenerator: ipKey,
});

const messageLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.MESSAGE_RATE_LIMIT_MAX) || 200,
  message: {
    success: false,
    error: {
      message: 'Too many message jobs, please wait before creating more',
      code: 'MESSAGE_RATE_LIMITED',
    },
  },
  keyGenerator: ipKey,
});

const scrapeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.SCRAPE_RATE_LIMIT_MAX) || 200,
  message: {
    success: false,
    error: {
      message: 'Scrape limit reached, please try again later',
      code: 'SCRAPE_RATE_LIMITED',
    },
  },
  keyGenerator: ipKey,
});

const createCustomLimiter = (options = {}) => {
  return rateLimit({
    windowMs: options.windowMs || 15 * 60 * 1000,
    max: options.max || 500,
    message: options.message || {
      success: false,
      error: {
        message: 'Too many requests',
        code: 'RATE_LIMITED',
      },
    },
    keyGenerator: options.keyGenerator || ipKey,
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
