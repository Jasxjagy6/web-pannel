/**
 * EmailReaderService
 * --------------------------------------------------------------------
 * Connects to an email inbox via IMAP and reads Telegram verification
 * codes automatically. Used by the login-mail bulk worker to turn a
 * fully-manual "send code → read email → type code" loop into a single
 * automated pass.
 *
 * Supported credential types:
 *   • password  — plain IMAP with email + app-password (Gmail, Outlook,
 *                 Yahoo, any IMAP server)
 *
 * Public API:
 *   testConnection(creds)                → { ok, error? }
 *   waitForTelegramOTP(creds, opts)      → { code, subject, receivedAt }
 *   autoDetectImapSettings(email)        → { host, port, tls }
 */

'use strict';

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const logger = require('../utils/logger');

// -----------------------------------------------------------------------
// Well-known IMAP hosts by domain suffix.
// -----------------------------------------------------------------------
const KNOWN_IMAP_HOSTS = {
  'gmail.com':        { host: 'imap.gmail.com',           port: 993, tls: true },
  'googlemail.com':   { host: 'imap.gmail.com',           port: 993, tls: true },
  'outlook.com':      { host: 'outlook.office365.com',    port: 993, tls: true },
  'hotmail.com':      { host: 'outlook.office365.com',    port: 993, tls: true },
  'live.com':         { host: 'outlook.office365.com',    port: 993, tls: true },
  'yahoo.com':        { host: 'imap.mail.yahoo.com',      port: 993, tls: true },
  'ymail.com':        { host: 'imap.mail.yahoo.com',      port: 993, tls: true },
  'icloud.com':       { host: 'imap.mail.me.com',         port: 993, tls: true },
  'me.com':           { host: 'imap.mail.me.com',         port: 993, tls: true },
  'aol.com':          { host: 'imap.aol.com',             port: 993, tls: true },
  'zoho.com':         { host: 'imap.zoho.com',            port: 993, tls: true },
  'protonmail.com':   { host: 'imap.protonmail.ch',       port: 993, tls: true },
  'proton.me':        { host: 'imap.protonmail.ch',       port: 993, tls: true },
  'mail.ru':          { host: 'imap.mail.ru',             port: 993, tls: true },
  'yandex.ru':        { host: 'imap.yandex.ru',           port: 993, tls: true },
  'yandex.com':       { host: 'imap.yandex.com',          port: 993, tls: true },
  'gmx.com':          { host: 'imap.gmx.com',             port: 993, tls: true },
  'gmx.net':          { host: 'imap.gmx.net',             port: 993, tls: true },
};

/**
 * Auto-detect IMAP settings from an email address's domain.
 *
 * @param {string} email
 * @returns {{ host: string, port: number, tls: boolean } | null}
 */
function autoDetectImapSettings(email) {
  if (!email || typeof email !== 'string') return null;
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return null;
  return KNOWN_IMAP_HOSTS[domain] || null;
}

/**
 * Build an ImapFlow client from credential params.
 */
function _buildClient(creds) {
  return new ImapFlow({
    host: creds.imap_host || creds.imapHost,
    port: creds.imap_port || creds.imapPort || 993,
    secure: creds.use_tls !== false && creds.useTls !== false,
    auth: {
      user: creds.imap_user || creds.imapUser || creds.email,
      pass: creds.imap_pass || creds.imapPass,
    },
    logger: false,
    // 30-second socket timeout; avoids hanging on dead connections.
    socketTimeout: 30_000,
    // Disable IDLE support to keep connections lean and predictable.
    disableAutoIdle: true,
  });
}

/**
 * Test that the given IMAP credentials are valid.
 *
 * @param {object} creds
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function testConnection(creds) {
  const client = _buildClient(creds);
  try {
    await client.connect();
    // Quick mailbox status check to ensure we have read access.
    await client.status('INBOX', { messages: true });
    await client.logout();
    return { ok: true };
  } catch (err) {
    const msg = (err && err.message) || String(err);
    logger.warn(`IMAP test failed for ${creds.email}: ${msg}`);
    return { ok: false, error: msg };
  } finally {
    try { client.close(); } catch (_) { /* already closed */ }
  }
}

// -----------------------------------------------------------------------
// OTP extraction helpers.
// -----------------------------------------------------------------------

/**
 * Known sender addresses Telegram uses for verification codes.
 */
const TG_SENDERS = [
  'noreply@telegram.org',
  'verify@telegram.org',
  'login@telegram.org',
  'notifications@telegram.org',
];

/**
 * Extract a Telegram verification code from an email body/subject.
 * Telegram login codes are 5-6 digit numbers.
 *
 * @param {string} text
 * @returns {string|null}
 */
function extractOTP(text) {
  if (!text) return null;
  // Pattern 1: "Your login code: 12345" or "Login code: 123456"
  const loginCodeMatch = text.match(/(?:login|verification|verify|confirm)\s*code[:\s]+(\d{4,8})/i);
  if (loginCodeMatch) return loginCodeMatch[1];
  // Pattern 2: standalone 5-6 digit code on its own line or surrounded by spaces
  const standaloneMatch = text.match(/\b(\d{5,6})\b/);
  if (standaloneMatch) return standaloneMatch[1];
  return null;
}

/**
 * Check if an email message is a Telegram verification email.
 */
function _isTelegramVerification(parsed) {
  const from = (parsed.from?.text || '').toLowerCase();
  const subject = (parsed.subject || '').toLowerCase();

  // Check sender
  const senderMatch = TG_SENDERS.some((s) => from.includes(s)) ||
    from.includes('telegram');

  // Check subject for verification keywords
  const subjectMatch = /(?:login|verif|code|confirm)/i.test(subject);

  return senderMatch || (subjectMatch && from.includes('telegram'));
}

/**
 * Wait for a Telegram verification OTP to arrive in the inbox.
 *
 * Polls the inbox every few seconds looking for a new Telegram email
 * that arrived after `sinceDate`. Extracts the OTP code from the
 * first matching message.
 *
 * @param {object} creds  — IMAP credentials
 * @param {object} [opts]
 * @param {Date}   [opts.sinceDate]     — only consider emails after this time (default: now - 30s)
 * @param {number} [opts.timeoutMs]     — max wait time (default: 90000 = 90s)
 * @param {number} [opts.pollIntervalMs] — check interval (default: 4000 = 4s)
 * @param {function} [opts.onCancel]    — if this returns true, abort early
 * @returns {Promise<{ code: string, subject: string, receivedAt: Date } | null>}
 */
async function waitForTelegramOTP(creds, opts = {}) {
  const sinceDate = opts.sinceDate || new Date(Date.now() - 30_000);
  const timeoutMs = opts.timeoutMs || 90_000;
  const pollIntervalMs = opts.pollIntervalMs || 4_000;
  const onCancel = opts.onCancel || (() => false);

  const deadline = Date.now() + timeoutMs;
  const client = _buildClient(creds);

  try {
    await client.connect();

    while (Date.now() < deadline) {
      if (onCancel()) {
        logger.info('OTP wait cancelled by caller');
        return null;
      }

      let lock;
      try {
        lock = await client.getMailboxLock('INBOX');

        // Search for recent emails (within the last 2 minutes as buffer).
        const searchDate = new Date(sinceDate.getTime() - 120_000);
        const searchCriteria = {
          since: searchDate,
          // Some IMAP servers don't support complex searches; fall back
          // to date-only and filter in-memory.
        };

        const messages = [];
        for await (const msg of client.fetch(searchCriteria, {
          source: true,
          uid: true,
          envelope: true,
        })) {
          messages.push(msg);
        }

        // Process in reverse chronological order (newest first).
        messages.sort((a, b) => {
          const dateA = a.envelope?.date ? new Date(a.envelope.date) : new Date(0);
          const dateB = b.envelope?.date ? new Date(b.envelope.date) : new Date(0);
          return dateB - dateA;
        });

        for (const msg of messages) {
          const msgDate = msg.envelope?.date ? new Date(msg.envelope.date) : null;
          // Skip messages older than our threshold.
          if (msgDate && msgDate < sinceDate) continue;

          try {
            const parsed = await simpleParser(msg.source);

            if (_isTelegramVerification(parsed)) {
              // Try extracting from text body, then HTML.
              const code =
                extractOTP(parsed.text) ||
                extractOTP(parsed.subject) ||
                extractOTP(parsed.html?.replace(/<[^>]+>/g, ' '));

              if (code) {
                logger.info(
                  `Telegram OTP found: code=${code}, subject="${parsed.subject}", ` +
                  `date=${msgDate?.toISOString()}`
                );
                return {
                  code,
                  subject: parsed.subject || '',
                  receivedAt: msgDate || new Date(),
                };
              }
            }
          } catch (parseErr) {
            logger.debug(`Failed to parse email: ${parseErr.message}`);
          }
        }
      } finally {
        if (lock) lock.release();
      }

      // Wait before next poll.
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    logger.warn('Telegram OTP wait timed out');
    return null;
  } catch (err) {
    logger.error(`IMAP OTP reader error: ${err.message}`);
    throw err;
  } finally {
    try { await client.logout(); } catch (_) { /* ignore */ }
    try { client.close(); } catch (_) { /* ignore */ }
  }
}

module.exports = {
  testConnection,
  waitForTelegramOTP,
  autoDetectImapSettings,
  extractOTP,
  KNOWN_IMAP_HOSTS,
};
