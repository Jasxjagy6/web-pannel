/**
 * Convert a GramJS string session into a Telethon `.session` SQLite file.
 *
 * The Telethon session file is a SQLite database with five tables:
 *
 *   - sessions        (dc_id, server_address, port, auth_key, takeout_id)
 *   - entities        (id, hash, username, phone, name, date)
 *   - sent_files      (md5_digest, file_size, type, id, hash)
 *   - update_state    (id, pts, qts, date, seq)
 *   - version         (version)
 *
 * GramJS string-session format (telegram-js, version "1"):
 *
 *   "1" + base64( dc_id[1] + server_ip[4] + port[2 BE] + auth_key[256] )
 *
 * GramJS encodes the server address as packed IPv4 (4 bytes). Telethon
 * stores the server address as a TEXT column. We round-trip the IP back
 * into dotted-quad form and write that into `server_address`.
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

/**
 * Decode a GramJS string session into its component parts.
 *
 * @param {string} sessionString - GramJS string session ("1<base64>")
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
  const buf = Buffer.from(sessionString.slice(1), 'base64');
  // 1 (dc) + 4 (ip) + 2 (port) + 256 (auth_key) = 263
  if (buf.length < 1 + 4 + 2 + 256) {
    throw new Error(
      `GramJS session payload too short (${buf.length} bytes; ` +
      `expected at least 263)`
    );
  }
  const dcId = buf.readUInt8(0);
  const ip = `${buf.readUInt8(1)}.${buf.readUInt8(2)}.${buf.readUInt8(3)}.${buf.readUInt8(4)}`;
  const port = buf.readUInt16BE(5);
  const authKey = buf.slice(7, 7 + 256);
  return { dcId, serverAddress: ip, port, authKey };
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
