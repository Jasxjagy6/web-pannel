const Database = require('better-sqlite3');

/**
 * Extract auth key and session data from a Telethon binary session file.
 *
 * @param {string} sessionPath - Path to the Telethon .session file
 * @returns {object} { authKey: Buffer, dcId: number, serverAddress: string, port: number }
 */
function extractTelethonSessionData(sessionPath) {
  const db = new Database(sessionPath, { readonly: true });

  try {
    let authKey = null;
    let dcId = 0;
    let serverAddress = '';
    let port = 443;

    // Try to read from 'sessions' table (Telethon schema)
    try {
      const sessionData = db.prepare("SELECT * FROM sessions LIMIT 1").get();
      
      if (sessionData) {
        authKey = sessionData.auth_key;
        dcId = sessionData.dc_id || 0;
        serverAddress = sessionData.server_address || '';
        port = sessionData.port || 443;
      }
    } catch (e) {
      throw new Error(`Could not read session data: ${e.message}`);
    }

    if (!authKey) {
      throw new Error('No auth key found in session file');
    }

    return {
      authKey: Buffer.from(authKey),
      dcId,
      serverAddress,
      port,
    };
  } finally {
    db.close();
  }
}

/**
 * Convert Telethon binary session to GramJS string session.
 * 
 * Based on GramJS StringSession.js source code:
 * - First char must be "1" (CURRENT_VERSION)
 * - Rest is base64 encoded binary data
 * - Binary format: dcId (1 byte) + serverAddress (4 bytes for IPv4) + port (2 bytes BE) + authKey (rest)
 * 
 * @param {string} sessionPath - Path to the Telethon .session file
 * @returns {string} GramJS-compatible string session
 */
function convertTelethonToGramJS(sessionPath) {
  const { authKey, dcId, serverAddress, port } = extractTelethonSessionData(sessionPath);
  
  // Build binary data in the exact format GramJS expects
  let data = Buffer.alloc(0);
  
  // 1. DC ID (1 byte)
  data = Buffer.concat([data, Buffer.from([dcId])]);
  
  // 2. Server address (4 bytes for IPv4)
  // Parse IP address (e.g., "149.154.167.40" -> [149, 154, 167, 40])
  const ipParts = serverAddress.split('.').map(p => parseInt(p, 10));
  if (ipParts.length === 4) {
    data = Buffer.concat([data, Buffer.from(ipParts)]);
  } else {
    // Fallback: use default Telegram DC IP (149.154.167.40 for DC 2)
    const defaultIPs = {
      1: [149, 154, 167, 40],
      2: [149, 154, 167, 40],
      3: [149, 154, 167, 41],
      4: [149, 154, 167, 42],
      5: [149, 154, 167, 43],
    };
    const ip = defaultIPs[dcId] || defaultIPs[2];
    data = Buffer.concat([data, Buffer.from(ip)]);
  }
  
  // 3. Port (2 bytes, big-endian)
  data = Buffer.concat([data, Buffer.alloc(2)]);
  data.writeUInt16BE(port, data.length - 2);
  
  // 4. Auth key (256 bytes)
  if (authKey.length !== 256) {
    throw new Error(`Auth key must be 256 bytes, got ${authKey.length}`);
  }
  data = Buffer.concat([data, authKey]);
  
  // Base64 encode and prepend version "1"
  const base64Data = data.toString('base64');
  const sessionString = '1' + base64Data;
  
  return sessionString;
}

module.exports = {
  convertTelethonToGramJS,
  extractTelethonSessionData,
};
