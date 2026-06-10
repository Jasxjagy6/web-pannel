/**
 * EmailReaderService
 * --------------------------------------------------------------------
 * Connects to an email inbox via IMAP and extracts Telegram
 * verification codes from incoming messages.
 *
 * Supports:
 *   - Any IMAP-compatible provider (Gmail, Outlook, Yahoo, custom)
 *   - App passwords for Gmail (when "Less secure apps" is off)
 *   - Polling mode: wait for the OTP email to arrive (up to timeout)
 *
 * The automated bulk-login-email flow works like this:
 *   1. loginEmailService.sendCode(sessionId, email) triggers Telegram
 *      to email a verification code.
 *   2. This service connects to the inbox, waits for the Telegram
 *      email, extracts the numeric code, and returns it.
 *   3. loginEmailService.verifyCode(sessionId, email, code) confirms it.
 *
 * Public API:
 *   fetchVerificationCode(imapConfig, opts)  → { code, subject, from }
 *   testConnection(imapConfig)               → { success, mailboxCount }
 *   WELL_KNOWN_PROVIDERS                     → preset IMAP host/port
 */

'use strict';

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errorHandler');

// Well-known IMAP server configs. The frontend offers a dropdown
// so the user doesn't have to know the IMAP host/port for common
// providers. "appPassword" is a hint that the provider requires
// an app-specific password, not the account password.
const WELL_KNOWN_PROVIDERS = Object.freeze({
  gmail: {
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    note: 'Use an App Password (Google → Security → 2-Step → App passwords)',
  },
  outlook: {
    host: 'outlook.office365.com',
    port: 993,
    secure: true,
    note: 'Use your Microsoft account password or an app password',
  },
  yahoo: {
    host: 'imap.mail.yahoo.com',
    port: 993,
    secure: true,
    note: 'Generate an App Password from Yahoo Account Security',
  },
  icloud: {
    host: 'imap.mail.me.com',
    port: 993,
    secure: true,
    note: 'Use an App-Specific Password from Apple ID settings',
  },
  custom: {
    host: null,
    port: 993,
    secure: true,
    note: 'Enter your IMAP server details manually',
  },
});

// Telegram sends OTP emails from these addresses.
const TELEGRAM_SENDERS = new Set([
  'noreply@telegram.org',
  'verify@telegram.org',
  'login@stel.com',
  'noreply@stel.com',
]);

// Regex patterns to extract numeric verification codes from Telegram
// emails. We try several patterns because Telegram's email templates
// vary by language and over time.
const CODE_PATTERNS = [
  // "Your login code: 12345" or "Login code: 12345"
  /(?:login|verification|verify|confirmation)\s*code[:\s]+(\d{4,8})/i,
  // "Code: 12345" standalone
  /\bcode[:\s]+(\d{4,8})\b/i,
  // Standalone 5-6 digit number (common in minimal Telegram emails)
  /\b(\d{5,6})\b/,
];

/**
 * Build an ImapFlow client config from user-supplied credentials.
 *
 * @param {object} imapConfig
 * @param {string} imapConfig.email     - The email address (used as IMAP username)
 * @param {string} imapConfig.password  - Email password or app password
 * @param {string} [imapConfig.provider] - One of WELL_KNOWN_PROVIDERS keys
 * @param {string} [imapConfig.host]    - Custom IMAP host
 * @param {number} [imapConfig.port]    - Custom IMAP port
 * @param {boolean} [imapConfig.secure] - TLS
 */
function _buildImapConfig(imapConfig) {
  const { email, password, provider, host, port, secure } = imapConfig;
  if (!email || !password) {
    throw new AppError('Email and password are required', 400, 'MISSING_CREDENTIALS');
  }

  let imapHost = host;
  let imapPort = port || 993;
  let imapSecure = secure !== false;

  if (provider && WELL_KNOWN_PROVIDERS[provider]) {
    const preset = WELL_KNOWN_PROVIDERS[provider];
    if (preset.host) {
      imapHost = imapHost || preset.host;
      imapPort = port || preset.port;
      imapSecure = secure !== undefined ? secure : preset.secure;
    }
  }

  if (!imapHost) {
    throw new AppError(
      'IMAP host is required. Pick a provider or enter a custom host.',
      400,
      'MISSING_HOST'
    );
  }

  return {
    host: imapHost,
    port: imapPort,
    secure: imapSecure,
    auth: {
      user: email,
      pass: password,
    },
    logger: false,
    // 30 second timeout for connections
    greetingTimeout: 30000,
    socketTimeout: 30000,
  };
}

/**
 * Extract a Telegram verification code from an email body.
 *
 * @param {string} text - Plain text body of the email
 * @returns {string|null} The extracted code or null
 */
function _extractCode(text) {
  if (!text) return null;
  for (const pattern of CODE_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) return match[1];
  }
  return null;
}

/**
 * Check if an email is from Telegram.
 *
 * @param {object} parsed - Parsed email from mailparser
 * @returns {boolean}
 */
function _isTelegramEmail(parsed) {
  const from = parsed.from && parsed.from.value;
  if (!from || !Array.isArray(from)) return false;
  return from.some((addr) => {
    const email = (addr.address || '').toLowerCase();
    return TELEGRAM_SENDERS.has(email) || email.endsWith('@telegram.org') || email.endsWith('@stel.com');
  });
}

/**
 * Test the IMAP connection. Returns success + mailbox count.
 *
 * @param {object} imapConfig
 * @returns {Promise<{ success: boolean, mailboxCount: number, error?: string }>}
 */
async function testConnection(imapConfig) {
  const config = _buildImapConfig(imapConfig);
  const client = new ImapFlow(config);

  try {
    await client.connect();
    // List mailboxes to verify full access
    const mailboxes = await client.list();
    await client.logout();
    return {
      success: true,
      mailboxCount: mailboxes.length,
    };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    logger.warn(`emailReaderService: IMAP connection test failed: ${msg}`);
    return {
      success: false,
      mailboxCount: 0,
      error: msg.length > 200 ? msg.slice(0, 200) : msg,
    };
  } finally {
    try { await client.logout(); } catch { /* already closed */ }
  }
}

/**
 * Connect to the inbox and search for a Telegram verification code.
 *
 * Strategy:
 *   1. Connect to INBOX.
 *   2. Search for recent emails from Telegram senders.
 *   3. Parse each from newest→oldest; extract the OTP code.
 *   4. If no code found yet and we're within the timeout, wait and
 *      retry (polling).
 *
 * @param {object} imapConfig - Credentials + server config
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=60000]     - Max time to wait for the email
 * @param {number} [opts.pollIntervalMs=3000] - How often to re-check
 * @param {Date}   [opts.sentAfter]           - Only consider emails after this time
 * @param {AbortSignal} [opts.signal]         - Cancellation signal
 * @returns {Promise<{ code: string, subject: string, from: string, receivedAt: Date }>}
 */
async function fetchVerificationCode(imapConfig, opts = {}) {
  const {
    timeoutMs = 60000,
    pollIntervalMs = 3000,
    sentAfter = new Date(Date.now() - 5 * 60 * 1000), // default: last 5 minutes
    signal,
  } = opts;

  const config = _buildImapConfig(imapConfig);
  const client = new ImapFlow(config);
  const deadline = Date.now() + timeoutMs;

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      while (Date.now() < deadline) {
        if (signal && signal.aborted) {
          throw new AppError('Email fetch cancelled', 499, 'CANCELLED');
        }

        // Search for recent messages. IMAP SINCE uses date-only
        // (no time), so we fetch the last day and filter by header date.
        const sinceDate = new Date(sentAfter);
        sinceDate.setHours(0, 0, 0, 0);

        const messages = await client.search({
          since: sinceDate,
        });

        if (messages && messages.length > 0) {
          // Fetch from newest to oldest — process most recent first.
          // Limit to last 20 messages to avoid scanning huge mailboxes.
          const recentIds = messages.slice(-20).reverse();

          for (const uid of recentIds) {
            if (signal && signal.aborted) {
              throw new AppError('Email fetch cancelled', 499, 'CANCELLED');
            }

            let rawSource;
            try {
              const download = await client.download(uid, undefined, { uid: true });
              if (!download || !download.content) continue;
              const chunks = [];
              for await (const chunk of download.content) {
                chunks.push(chunk);
              }
              rawSource = Buffer.concat(chunks);
            } catch (dlErr) {
              logger.debug(`emailReader: failed to download message ${uid}: ${dlErr.message}`);
              continue;
            }

            let parsed;
            try {
              parsed = await simpleParser(rawSource);
            } catch (parseErr) {
              logger.debug(`emailReader: failed to parse message ${uid}: ${parseErr.message}`);
              continue;
            }

            // Skip if not from Telegram
            if (!_isTelegramEmail(parsed)) continue;

            // Skip if older than sentAfter
            const emailDate = parsed.date || new Date(0);
            if (emailDate < sentAfter) continue;

            // Try to extract the code
            const text = parsed.text || '';
            const html = parsed.html || '';
            const code = _extractCode(text) || _extractCode(html.replace(/<[^>]+>/g, ' '));

            if (code) {
              const fromAddr = parsed.from && parsed.from.value
                ? parsed.from.value.map((a) => a.address).join(', ')
                : 'unknown';

              logger.info(
                `emailReader: found Telegram OTP code (length=${code.length}) from ${fromAddr}`
              );

              return {
                code,
                subject: parsed.subject || '',
                from: fromAddr,
                receivedAt: emailDate,
              };
            }
          }
        }

        // No code found yet — wait and retry
        if (Date.now() + pollIntervalMs < deadline) {
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        } else {
          break;
        }
      }

      throw new AppError(
        'Timed out waiting for Telegram verification email. Check that the email address is correct and the inbox is accessible.',
        408,
        'EMAIL_TIMEOUT'
      );
    } finally {
      lock.release();
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    const msg = err && err.message ? err.message : String(err);
    logger.warn(`emailReaderService: fetchVerificationCode failed: ${msg}`);
    throw new AppError(
      `Failed to read email: ${msg.length > 200 ? msg.slice(0, 200) : msg}`,
      502,
      'EMAIL_READ_FAILED'
    );
  } finally {
    try { await client.logout(); } catch { /* already closed */ }
  }
}

module.exports = {
  fetchVerificationCode,
  testConnection,
  WELL_KNOWN_PROVIDERS,
  // Exported for testing
  _extractCode,
  _isTelegramEmail,
};
