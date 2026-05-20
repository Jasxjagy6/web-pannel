#!/usr/bin/env node
/* eslint-env node */
/* eslint-disable no-console */
'use strict';

/**
 * Re-build the `.session` SQLite files inside a panel `clone-export-*.zip`
 * using the (now-fixed) GramJS→Telethon converter.
 *
 * Older versions of the panel shipped a buggy `decodeGramJSSession`
 * that treated GramJS's address-prefixed payload as Telethon's
 * packed-IPv4 payload. The result was every cloned `.session` had
 * `server_address="0.13.57.49"`, `port=11825`, and a 7-byte-offset
 * `auth_key` — Telethon would open the database but immediately fail
 * to authenticate.
 *
 * The JSON envelopes inside the zip already contain the correct
 * `stringSession`. This script reads each `*.json`, runs it through
 * the fixed converter, replaces the corresponding `*.session` with a
 * properly-built SQLite database, and emits a new zip alongside the
 * original.
 *
 * Usage:
 *   node backend/scripts/repairCloneExport.js <input.zip> [<output.zip>]
 *
 * The output zip preserves the original `manifest.json`. The
 * `*.session` files inside are the *only* thing that changes.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

const {
  decodeGramJSSession,
  writeTelethonSessionFile,
} = require('../src/utils/gramjsToTelethon');

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.length > 2) {
    console.error('usage: repairCloneExport.js <input.zip> [<output.zip>]');
    process.exit(2);
  }
  const input = path.resolve(args[0]);
  if (!fs.existsSync(input)) fail(`input zip not found: ${input}`);

  const output = args[1]
    ? path.resolve(args[1])
    : input.replace(/\.zip$/i, '.repaired.zip').replace(/^(?!\/)/, path.resolve('') + path.sep);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-repair-'));
  console.log(`-> staging dir: ${work}`);

  const inZip = new AdmZip(input);
  inZip.extractAllTo(work, /* overwrite */ true);

  // Find every <basename>.json with a sibling <basename>.session.
  const entries = fs.readdirSync(work);
  const sessionEntries = entries.filter((e) => e.endsWith('.session'));
  if (sessionEntries.length === 0) {
    fail('no .session files found in the zip');
  }

  console.log(`-> found ${sessionEntries.length} session files`);

  const report = [];
  for (const sessionFile of sessionEntries) {
    const base = sessionFile.replace(/\.session$/, '');
    const jsonFile = `${base}.json`;
    const jsonPath = path.join(work, jsonFile);
    if (!fs.existsSync(jsonPath)) {
      console.warn(`   ${sessionFile}: no matching ${jsonFile}; skipped`);
      continue;
    }
    let env;
    try {
      env = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch (e) {
      console.warn(`   ${sessionFile}: ${jsonFile} is not valid JSON; skipped`);
      continue;
    }
    const ss = env.stringSession;
    if (typeof ss !== 'string' || ss.length < 8) {
      console.warn(`   ${sessionFile}: envelope has no stringSession; skipped`);
      continue;
    }
    let decoded;
    try {
      decoded = decodeGramJSSession(ss);
    } catch (e) {
      console.warn(`   ${sessionFile}: stringSession does not decode (${e.message}); skipped`);
      continue;
    }
    const sessionPath = path.join(work, sessionFile);
    writeTelethonSessionFile(ss, sessionPath);
    report.push({
      file: sessionFile,
      dcId: decoded.dcId,
      serverAddress: decoded.serverAddress,
      port: decoded.port,
      authKeyLen: decoded.authKey.length,
    });
    console.log(
      `   ${sessionFile}: dc=${decoded.dcId} ` +
      `addr=${decoded.serverAddress}:${decoded.port}`
    );
  }

  if (report.length === 0) fail('no files were repaired');

  // Rebuild the zip with every staged file (including the original
  // manifest.json + every .json envelope).
  const outZip = new AdmZip();
  for (const entry of fs.readdirSync(work)) {
    outZip.addLocalFile(path.join(work, entry));
  }
  outZip.writeZip(output);

  console.log(`\nRepaired ${report.length} session file(s).`);
  console.log(`Wrote: ${output}`);
}

main();
