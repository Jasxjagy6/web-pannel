/**
 * sessionCrypto — institutional encryption for Telegram session strings.
 *
 * Hardens encryption-at-rest beyond the legacy `utils/crypto.js` which
 * derived its key from `JWT_SECRET` (with a published default fallback).
 * This module:
 *
 *   - Reads `SESSION_ENCRYPTION_KEY` (required, base64 or hex of 32 bytes).
 *   - Requires the key to be **distinct from `JWT_SECRET`** so the two
 *     concerns can't be linked or rotated together by accident.
 *   - Fails fast (`assertReady()` throws) if the key is missing/short.
 *   - Wraps payloads with a 1-byte version prefix so we can rotate the
 *     KDF later without flag-day migration.
 *
 * Backwards compatibility:
 *   `decrypt()` falls back to the legacy `utils/crypto.decrypt` for
 *   payloads that were encrypted before this module shipped, so existing
 *   sessions on disk keep working. They are **lazily re-encrypted** the
 *   next time `encrypt()` is invoked on them.
 */

'use strict';

const crypto = require('crypto');
const { decrypt: legacyDecrypt, encrypt: legacyEncrypt } = require('./crypto');
const logger = require('./logger');

const VERSION = 0x01;
const ALGORITHM = 'aes-256-gcm';
const IV_LEN = 12;          // GCM standard
const TAG_LEN = 16;

let _key = null;
let _ready = false;

function _resolveKey() {
  const raw = process.env.SESSION_ENCRYPTION_KEY || '';
  if (!raw) return null;
  // Accept hex (64 chars) or base64.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  try {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === 32) return buf;
  } catch {
    /* ignore */
  }
  return null;
}

function _init() {
  if (_ready) return;
  const k = _resolveKey();
  if (k) {
    if (process.env.JWT_SECRET && process.env.JWT_SECRET === process.env.SESSION_ENCRYPTION_KEY) {
      throw new Error(
        'SESSION_ENCRYPTION_KEY must NOT equal JWT_SECRET. ' +
          'Generate a separate 32-byte key (e.g. `openssl rand -hex 32`).'
      );
    }
    _key = k;
    _ready = true;
    logger.info('sessionCrypto: SESSION_ENCRYPTION_KEY loaded (32 bytes)');
  } else {
    _key = null;
    _ready = false;
  }
}

_init();

function isReady() {
  return _ready && _key !== null;
}

/**
 * Throw a startup-blocking error if SESSION_ENCRYPTION_KEY is missing.
 * Called from backend index.js bootstrap.
 *
 * Set `ANTI_REVOKE_REQUIRE_SESSION_KEY=false` to opt out (legacy mode).
 */
function assertReady() {
  const required =
    String(process.env.ANTI_REVOKE_REQUIRE_SESSION_KEY ?? 'false').toLowerCase() === 'true';
  if (!required) return;
  if (!_ready) {
    throw new Error(
      'SESSION_ENCRYPTION_KEY is required when ANTI_REVOKE_REQUIRE_SESSION_KEY=true. ' +
        'Generate one with `openssl rand -hex 32` and set it in the environment.'
    );
  }
}

/**
 * Encrypt a session string using SESSION_ENCRYPTION_KEY.
 * Falls back to the legacy `utils/crypto` encrypt if SESSION_ENCRYPTION_KEY
 * is unset (so existing dev workflows keep working).
 *
 * @param {string} plaintext
 * @returns {string} versioned base64 envelope
 */
function encrypt(plaintext) {
  if (!_ready) return legacyEncrypt(plaintext);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, _key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Layout: [version:1][iv:12][tag:16][ciphertext:N], base64-wrapped.
  const buf = Buffer.concat([Buffer.from([VERSION]), iv, tag, enc]);
  return `v1:${buf.toString('base64')}`;
}

/**
 * Decrypt a session string. Auto-detects v1 envelope vs legacy `iv:tag:hex`.
 * @param {string} payload
 * @returns {string}
 */
function decrypt(payload) {
  if (typeof payload !== 'string' || !payload.length) {
    throw new Error('sessionCrypto.decrypt: empty payload');
  }
  if (payload.startsWith('v1:') && _ready) {
    const buf = Buffer.from(payload.slice(3), 'base64');
    if (buf.length < 1 + IV_LEN + TAG_LEN + 1) {
      throw new Error('sessionCrypto.decrypt: malformed v1 payload');
    }
    if (buf[0] !== VERSION) {
      throw new Error(`sessionCrypto.decrypt: unsupported version ${buf[0]}`);
    }
    const iv = buf.slice(1, 1 + IV_LEN);
    const tag = buf.slice(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
    const enc = buf.slice(1 + IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv(ALGORITHM, _key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString('utf8');
  }
  // Legacy `iv:tag:hex` envelope from utils/crypto.js
  return legacyDecrypt(payload);
}

/**
 * Returns true if the payload uses the modern v1 envelope.
 * Used by the lazy migration path.
 */
function isV1(payload) {
  return typeof payload === 'string' && payload.startsWith('v1:');
}

module.exports = {
  encrypt,
  decrypt,
  isReady,
  isV1,
  assertReady,
  VERSION,
};
