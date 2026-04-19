require('dotenv').config();

const telegramConfig = {
  apiId: parseInt(process.env.TELEGRAM_API_ID || '0'),
  apiHash: process.env.TELEGRAM_API_HASH || '',
  connectionRetries: 5,
  timeout: 30000,
  baseLogger: null, // Disable GramJS internal logging - we use our own logger
  useWSS: true,
  deviceModel: 'Mozilla/5.0 (X11; Linux x86_64)',
  systemVersion: 'Node.js',
  appVersion: '1.0.0',
  langCode: 'en',
};

if (!telegramConfig.apiId || !telegramConfig.apiHash) {
  console.warn('WARNING: TELEGRAM_API_ID and TELEGRAM_API_HASH are not set');
}

module.exports = telegramConfig;
