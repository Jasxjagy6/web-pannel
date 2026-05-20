/**
 * Convert a GramJS or Telethon string session into a Telethon `.session`
 * SQLite file.
 *
 * The Telethon session file is a SQLite database with five tables:
 *
 *   - sessions        (dc_id, server_address, port, auth_key, takeout_id)
 *   - entities        (id, hash, username, phone, name, date)
 *   - sent_files      (md5_digest, file_size, type, id, hash)
 *   - update_state    (id, pts, qts, date, seq)
 *   - version         (version)
 *
 * String-session formats (both start with the version byte "1"):
 *
 *   GramJS (telegram-js, what this panel actually produces):
 *     "1" + base64(
 *       dc_id[1] +
 *       address_length[2 BE] +
 *       server_address[address_length, ASCII]  // e.g. "91.108.56.152"
 *       port[2 BE] +
 *       auth_key[256]
 *     )
 *
 *   Telethon (python-telethon, what some imported sessions use):
 *     "1" + base64(
 *       dc_id[1] +
 *       server_ip[4 packed bytes  for IPv4]   // e.g. <91><108><56><152>
 *         (or 16 packed bytes for IPv6)
 *       port[2 BE] +
 *       auth_key[256]
 *     )
 *
 * Historically this file only knew about the Telethon (packed-IP)
 * format, but the panel signs sessions with GramJS. That meant the
 * exported .session files contained junk values for `server_address`,
 * `port`, and `auth_key` — Telethon would happily open the database
 * and immediately fail to log in because the auth_key bytes were
 * offset by 7 (the size of the address-prefixed header).
 *
 * The decoder below auto-detects which format the payload is in (the
 * GramJS format always has `address_length >= 7` and never starts
 * with `0x00` while the packed-IPv4 first octet is 1..255, so the
 * second byte being 0x00 is the unambiguous signal) and round-trips
 * the IP into dotted-quad form in either case.
 *
 * The output file is written to `outPath` and the path is returned.
 *
 * Telethon currently uses schema `version = 7` (Telethon >= 1.32). We pin
 * to that so a recent Telethon client opens the file without prompting
 * for a migration.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const TELETHON_SCHEMA_VERSION = 7;

const TELETHON_PACKED_IPV4_LEN = 1 + 4 + 2 + 256;   // 263
const TELETHON_PACKED_IPV6_LEN = 1 + 16 + 2 + 256;  // 275

/**
 * Decode a GramJS- or Telethon-flavoured string session into its
 * component parts.
 *
 * @param {string} sessionString - GramJS / Telethon string session ("1<base64>")
 * @returns {{ dcId: number, serverAddress: string, port: number, authKey: Buffer }}
 */
function decodeGramJSSession(sessionString) {
  if (typeof sessionString !== 'string' || sessionString.length < 2) {
    throw new Error('GramJS session string is empty or invalid');
  }
  if (sessionString[0] !== '1') {
    throw new Error(
      `Unsupported GramJS string-session version: "${sessionString[0]}" ` +
      `(expected "1")`
    );
  }
  const b64 = sessionString.slice(1).replace(/-/g, '+').replace(/_/g, '/');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < TELETHON_PACKED_IPV4_LEN) {
    throw new Error(
      `Session payload too short (${buf.length} bytes; ` +
      `expected at least ${TELETHON_PACKED_IPV4_LEN})`
    );
  }
  const dcId = buf.readUInt8(0);

  // --- GramJS format detection ----------------------------------------
  // Address length is a 2-byte big-endian count followed by that many
  // ASCII bytes. A valid dotted-quad IPv4 is 7-15 chars ("1.1.1.1" to
  // "255.255.255.255") and a valid IPv6 string is up to 45 chars. We
  // accept 7..45 here. If the prefix matches AND the total length is
  // exactly `1 + 2 + addrLen + 2 + 256`, treat it as GramJS.
  const addrLen = buf.readUInt16BE(1);
  if (addrLen >= 7 && addrLen <= 45 && buf.length === 1 + 2 + addrLen + 2 + 256) {
    const addressBytes = buf.slice(3, 3 + addrLen);
    const address = addressBytes.toString('utf8');
    // Bail if the address bytes look like packed bytes accidentally
    // — a valid GramJS address is purely characters in [0-9a-fA-F:.].
    if (/^[0-9a-fA-F:.]+$/.test(address)) {
      const port = buf.readUInt16BE(3 + addrLen);
      const authKey = buf.slice(3 + addrLen + 2, 3 + addrLen + 2 + 256);
      return { dcId, serverAddress: address, port, authKey };
    }
  }

  // --- Telethon packed-IPv4 (263 bytes) ------------------------------
  if (buf.length === TELETHON_PACKED_IPV4_LEN) {
    const ip = `${buf.readUInt8(1)}.${buf.readUInt8(2)}.${buf.readUInt8(3)}.${buf.readUInt8(4)}`;
    const port = buf.readUInt16BE(5);
    const authKey = buf.slice(7, 7 + 256);
    return { dcId, serverAddress: ip, port, authKey };
  }

  // --- Telethon packed-IPv6 (275 bytes) -------------------------------
  if (buf.length === TELETHON_PACKED_IPV6_LEN) {
    const parts = [];
    for (let i = 0; i < 8; i += 1) {
      parts.push(buf.readUInt16BE(1 + i * 2).toString(16));
    }
    const ip = parts.join(':');
    const port = buf.readUInt16BE(1 + 16);
    const authKey = buf.slice(1 + 16 + 2, 1 + 16 + 2 + 256);
    return { dcId, serverAddress: ip, port, authKey };
  }

  throw new Error(
    `Unrecognized string-session payload length: ${buf.length} bytes ` +
    `(expected ${TELETHON_PACKED_IPV4_LEN}, ${TELETHON_PACKED_IPV6_LEN}, ` +
    `or 1+2+addrLen+2+256 for GramJS)`
  );
}

/**
 * Initialise a fresh Telethon-format SQLite database at `outPath` and
 * populate it with the session row derived from `sessionString`.
 *
 * @param {string} sessionString - GramJS string session
 * @param {string} outPath - Absolute path to write the .session file to
 * @returns {string} The path that was written to.
 */
function writeTelethonSessionFile(sessionString, outPath) {
  const decoded = decodeGramJSSession(sessionString);

  // Make sure we start fresh — better-sqlite3 will silently open an
  // existing DB and `CREATE TABLE` would then fail. Removing the file
  // also avoids leaking schema mismatches between subsequent downloads
  // of the same session.
  try { fs.unlinkSync(outPath); } catch (_) { /* not present */ }

  const dirname = path.dirname(outPath);
  if (!fs.existsSync(dirname)) {
    fs.mkdirSync(dirname, { recursive: true });
  }

  const db = new Database(outPath);
  try {
    db.pragma('journal_mode = DELETE');
    // Telethon's exact schema. Column order matches Telethon
    // `sessions/sqlite.py` so older Telethon versions that do
    // `SELECT * FROM sessions` see the same shape.
    db.exec(`
      CREATE TABLE sessions (
        dc_id INTEGER PRIMARY KEY,
        server_address TEXT,
        port INTEGER,
        auth_key BLOB,
        takeout_id INTEGER
      );
      CREATE TABLE entities (
        id INTEGER PRIMARY KEY,
        hash INTEGER NOT NULL,
        username TEXT,
        phone INTEGER,
        name TEXT,
        date INTEGER
      );
      CREATE TABLE sent_files (
        md5_digest BLOB,
        file_size INTEGER,
        type INTEGER,
        id INTEGER,
        hash INTEGER,
        PRIMARY KEY(md5_digest, file_size, type)
      );
      CREATE TABLE update_state (
        id INTEGER PRIMARY KEY,
        pts INTEGER,
        qts INTEGER,
        date INTEGER,
        seq INTEGER
      );
      CREATE TABLE version (
        version INTEGER PRIMARY KEY
      );
    `);

    db.prepare('INSERT INTO version (version) VALUES (?)')
      .run(TELETHON_SCHEMA_VERSION);

    db.prepare(
      `INSERT INTO sessions (dc_id, server_address, port, auth_key, takeout_id)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      decoded.dcId,
      decoded.serverAddress,
      decoded.port,
      decoded.authKey,
      null
    );
  } finally {
    db.close();
  }

  return outPath;
}

module.exports = {
  decodeGramJSSession,
  writeTelethonSessionFile,
  TELETHON_SCHEMA_VERSION,
};
