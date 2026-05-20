/**
 * Time-based One-Time Password (RFC 6238) — used to solve the 2FA
 * step of a Reddit (or any TOTP-protected) login when the operator
 * has stored the shared secret on the account row.
 *
 * No external dependency: HMAC-SHA1, 30-second window, 6-digit code.
 */

'use strict';

const crypto = require('crypto');

/**
 * Decode a RFC 4648 base32 string into a Buffer. We deliberately do
 * NOT pull a `base32` npm dep — the algorithm is 20 lines.
 */
function base32Decode(input) {
  if (!input) return Buffer.alloc(0);
  const cleaned = String(input)
    .toUpperCase()
    .replace(/=+$/, '')
    .replace(/\s+/g, '');
  if (!cleaned) return Buffer.alloc(0);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of cleaned) {
    const idx = alphabet.indexOf(c);
    if (idx < 0) throw new Error(`invalid base32 char: ${c}`);
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/**
 * HOTP per RFC 4226 — 6-digit code from (key, counter).
 */
function hotp(keyBuf, counter, digits = 6) {
  const buf = Buffer.alloc(8);
  // Counter is 8 bytes big-endian; JS bitwise ops cap at 32 bits so
  // we split high/low.
  let c = BigInt(counter);
  for (let i = 7; i >= 0; i -= 1) {
    buf[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  const h = crypto.createHmac('sha1', keyBuf).update(buf).digest();
  const offset = h[h.length - 1] & 0x0f;
  const binary =
    ((h[offset] & 0x7f) << 24) |
    ((h[offset + 1] & 0xff) << 16) |
    ((h[offset + 2] & 0xff) << 8) |
    (h[offset + 3] & 0xff);
  const code = binary % 10 ** digits;
  return String(code).padStart(digits, '0');
}

/**
 * TOTP per RFC 6238 — generates the current 6-digit code from a
 * base32-encoded shared secret. `whenMs` is for testing; defaults to
 * `Date.now()`.
 */
function totp(secretBase32, opts = {}) {
  const digits = opts.digits || 6;
  const stepSeconds = opts.step || 30;
  const whenMs = opts.whenMs || Date.now();
  const key = base32Decode(secretBase32);
  if (!key.length) throw new Error('TOTP secret decoded to empty buffer');
  const counter = Math.floor(whenMs / 1000 / stepSeconds);
  return hotp(key, counter, digits);
}

module.exports = { totp, hotp, base32Decode };
