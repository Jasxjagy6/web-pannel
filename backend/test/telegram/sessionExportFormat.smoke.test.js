/* eslint-env node */
/* eslint-disable global-require */
'use strict';

/**
 * Smoke test for the GramJS / Telethon string-session decoder used by
 * the session-clone export pipeline.
 *
 * This used to ship a decoder that only understood Telethon's packed
 * IPv4 format, but the panel signs sessions with GramJS, which uses
 * an address-prefixed format. The bug surfaced as cloned `.session`
 * files containing junk values for `server_address` (e.g. "0.13.57.49"),
 * `port` (e.g. 11825) and a 7-byte-offset `auth_key` — Telethon would
 * open the file fine but immediately fail to log in.
 *
 *   S1: GramJS-style address-prefixed payload decodes correctly
 *   S2: Telethon-style packed IPv4 payload still decodes correctly
 *   S3: Telethon-style packed IPv6 payload decodes correctly
 *   S4: writeTelethonSessionFile produces a valid SQLite database with
 *       the right `(dc_id, server_address, port, auth_key)` row
 *   S5: bad inputs are rejected with a clear error
 *
 * Run with: `node test/telegram/sessionExportFormat.smoke.test.js`
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { decodeGramJSSession, writeTelethonSessionFile } =
  require('../../src/utils/gramjsToTelethon');

const realAuthKey = Buffer.alloc(256);
for (let i = 0; i < 256; i += 1) realAuthKey[i] = (i * 7 + 3) & 0xff;

function encodeGramJSStyle(dcId, addr, port, authKey) {
  const addrBuf = Buffer.from(addr, 'utf8');
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16BE(addrBuf.length, 0);
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port, 0);
  const all = Buffer.concat([Buffer.from([dcId]), lenBuf, addrBuf, portBuf, authKey]);
  return '1' + all.toString('base64');
}

function encodeTelethonPackedIPv4(dcId, addr, port, authKey) {
  const parts = addr.split('.').map((p) => parseInt(p, 10));
  assert.strictEqual(parts.length, 4);
  const ip = Buffer.from(parts);
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port, 0);
  const all = Buffer.concat([Buffer.from([dcId]), ip, portBuf, authKey]);
  return '1' + all.toString('base64');
}

function encodeTelethonPackedIPv6(dcId, groups8, port, authKey) {
  const ip = Buffer.alloc(16);
  for (let i = 0; i < 8; i += 1) ip.writeUInt16BE(groups8[i] || 0, i * 2);
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port, 0);
  const all = Buffer.concat([Buffer.from([dcId]), ip, portBuf, authKey]);
  return '1' + all.toString('base64');
}

let failures = 0;
function ok(name) { console.log(`  PASS  ${name}`); }
function fail(name, err) {
  failures += 1;
  console.error(`  FAIL  ${name}: ${err.message}\n${err.stack}`);
}
async function test(name, fn) {
  try { await fn(); ok(name); } catch (err) { fail(name, err); }
}

(async () => {
  console.log('Telegram session export-format smoke');

  await test('S1: GramJS address-prefixed payload decodes', () => {
    const s = encodeGramJSStyle(5, '91.108.56.152', 443, realAuthKey);
    const d = decodeGramJSSession(s);
    assert.strictEqual(d.dcId, 5);
    assert.strictEqual(d.serverAddress, '91.108.56.152');
    assert.strictEqual(d.port, 443);
    assert.strictEqual(d.authKey.length, 256);
    assert.ok(d.authKey.equals(realAuthKey),
      'authKey bytes were not round-tripped exactly');
  });

  await test('S2: Telethon packed IPv4 payload still decodes', () => {
    const s = encodeTelethonPackedIPv4(2, '149.154.167.50', 443, realAuthKey);
    const d = decodeGramJSSession(s);
    assert.strictEqual(d.dcId, 2);
    assert.strictEqual(d.serverAddress, '149.154.167.50');
    assert.strictEqual(d.port, 443);
    assert.ok(d.authKey.equals(realAuthKey));
  });

  await test('S3: Telethon packed IPv6 payload decodes', () => {
    const s = encodeTelethonPackedIPv6(
      4,
      [0x2001, 0xb28, 0xf23f, 0xf005, 0, 0, 0, 0xa],
      443,
      realAuthKey
    );
    const d = decodeGramJSSession(s);
    assert.strictEqual(d.dcId, 4);
    assert.strictEqual(d.serverAddress, '2001:b28:f23f:f005:0:0:0:a');
    assert.strictEqual(d.port, 443);
    assert.ok(d.authKey.equals(realAuthKey));
  });

  await test('S4: writeTelethonSessionFile writes the correct SQLite row', () => {
    const s = encodeGramJSStyle(5, '91.108.56.152', 443, realAuthKey);
    const tmp = path.join(os.tmpdir(), `panel-clone-test-${Date.now()}.session`);
    try {
      writeTelethonSessionFile(s, tmp);
      const db = new Database(tmp, { readonly: true });
      try {
        const row = db.prepare(
          'SELECT dc_id, server_address, port, auth_key, takeout_id FROM sessions'
        ).get();
        assert.strictEqual(row.dc_id, 5);
        assert.strictEqual(row.server_address, '91.108.56.152');
        assert.strictEqual(row.port, 443);
        assert.strictEqual(row.takeout_id, null);
        assert.ok(Buffer.isBuffer(row.auth_key), 'auth_key must be a BLOB');
        assert.strictEqual(row.auth_key.length, 256, 'auth_key must be 256 bytes');
        assert.ok(row.auth_key.equals(realAuthKey),
          'auth_key was offset / corrupted — this is the original cloning bug');
        const version = db.prepare('SELECT version FROM version').get();
        assert.strictEqual(version.version, 7);
      } finally {
        db.close();
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    }
  });

  await test('S5: bogus / short payloads are rejected', () => {
    assert.throws(() => decodeGramJSSession(''));
    assert.throws(() => decodeGramJSSession('1AA=='));
    assert.throws(() => decodeGramJSSession('2' + Buffer.alloc(263).toString('base64')));
  });

  // -- Regression vector: the literal payload from the user-supplied
  //    broken zip. Before the fix this produced server="0.13.57.49"
  //    port=11825 and a 7-byte-offset auth_key.
  await test('S6: regression — exact payload from user-supplied broken zip', () => {
    const s = '1BQANOTEuMTA4LjU2LjE1MgG7gakM13StBfL7iq+hxnxQiGc2lHXfFUWKC54xg6hV4CUiWLPe64Sp6P7jzL+EQoFuI0aJREETwsruY8yrhUQlbVbEJn2O9GUTcv0ohLEiHD9vtMl5VlAPMZsTam8EmUJzC43l+J0Dv1BzekBQWHnnytZCY0+zqexVjiaN4klz3guDly/zRoGjYt0NrfQ6mJlecLPv9Kbvzzt8tO2TEblOXxGNj3gDXZ5FLRopH/kzE37fCszPCIP6LgDiyi4COLhjwjGptgZYbgeDNDVvqMEkkSrvS7UbNAO+vn7cWuMwDhZuK2GMgK/DLRejPWxoLMCiagQ3BtkNS7YMdPmLyBBAKg==';
    const d = decodeGramJSSession(s);
    assert.strictEqual(d.dcId, 5);
    assert.strictEqual(d.serverAddress, '91.108.56.152');
    assert.strictEqual(d.port, 443);
    assert.strictEqual(d.authKey.length, 256);
    // First 4 bytes of the real auth_key, established empirically from
    // the StringSession decode above.
    assert.strictEqual(d.authKey.slice(0, 4).toString('hex'), '81a90cd7');
  });

  console.log(failures === 0
    ? '\nAll session-export-format smoke tests passed.'
    : `\n${failures} test(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
})();
