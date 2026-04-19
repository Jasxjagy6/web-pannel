const logger = require('./logger');

class AppError extends Error {
  constructor(message, statusCode = 500, errorCode = 'INTERNAL_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

const errorHandler = (err, req, res, next) => {
  let { statusCode, message, errorCode } = err;

  if (!statusCode) {
    statusCode = 500;
  }

  if (!errorCode) {
    errorCode = 'INTERNAL_ERROR';
  }

  // Always log full error details for debugging
  logger.error(`${err.message}`, {
    errorCode,
    statusCode,
    url: req.originalUrl,
    method: req.method,
    stack: err.stack,
  });

  if (process.env.NODE_ENV === 'production' && statusCode === 500) {
    message = 'An unexpected error occurred';
  }

  res.status(statusCode).json({
    success: false,
    error: {
      message,
      code: errorCode,
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    },
  });
};

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

const handleTelegramError = (error) => {
  const errorMessages = {
    FLOOD_WAIT: (seconds) => `Rate limited. Please wait ${seconds} seconds`,
    SESSION_REVOKED: 'Session has been revoked',
    USER_BANNED_IN_CHANNEL: 'User is banned in channel',
    PRIVACY_RESTRICTED: 'User privacy settings restrict this action',
    PHONE_NUMBER_INVALID: 'Invalid phone number provided',
    API_ID_INVALID: 'Invalid API ID',
    API_HASH_INVALID: 'Invalid API Hash',
    SESSION_EXPIRED: 'Session has expired',
    AUTH_KEY_UNREGISTERED: 'Session is not authorized',
    USER_NOT_MUTUAL_CONTACT: 'User is not a mutual contact',
    CHAT_ADMIN_REQUIRED: 'Admin rights required for this action',
    CHAT_WRITE_FORBIDDEN: 'Write permission denied in this chat',
    MESSAGE_TOO_LONG: 'Message exceeds maximum length',
    MEDIA_INVALID: 'Invalid media file provided',
    INPUT_USER_DEACTIVATED: 'User account has been deactivated',
    PEER_FLOOD: 'Too many actions, please wait before trying again',
  };

  if (error && error.message) {
    for (const [key, handler] of Object.entries(errorMessages)) {
      if (error.message.includes(key)) {
        if (key === 'FLOOD_WAIT') {
          const match = error.message.match(/(\d+)/);
          const seconds = match ? parseInt(match[1]) : 30;
          return { error: handler(seconds), code: 'FLOOD_WAIT', seconds };
        }
        return { error: handler, code: key };
      }
    }
  }

  return { error: error?.message || 'Unknown Telegram API error', code: 'TELEGRAM_API_ERROR' };
};

module.exports = {
  AppError,
  errorHandler,
  asyncHandler,
  handleTelegramError,
};
