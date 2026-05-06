/**
 * Smoke test for the list-import + bulk-DM bug fix.
 *
 * 1. The Telegram scrape export attached by the user mixes numeric
 *    Telegram ids with UUID-style placeholder ids (for hidden users).
 *    The CSV parser must:
 *      - keep numeric-id rows as-is
 *      - keep UUID-id rows when they have a usable username
 *      - drop UUID-id rows that have no usable handle
 * 2. The bulk-message normalizer must fall back to `@username` for
 *    rows whose telegram_id is null or non-numeric, so DMs to
 *    handle-only entries still reach `_resolveEntity`.
 *
 * The services pull in DB / queue modules at require()-time, so we
 * stub those out before loading. Helpers are exposed via
 * `module.exports.__internal`.
 */

'use strict';

const assert = require('assert');

// ---- Stubs so the services can be require()'d without infra. ----
function stubModule(modPath, exportsObj) {
  const resolved = require.resolve(modPath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsObj,
  };
}
stubModule('../../src/config/database', {
  pool: {
    query: async () => ({ rows: [] }),
    connect: async () => ({}),
  },
});
stubModule('../../src/utils/logger', {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
});

// messageService deps that touch real I/O at module load.
stubModule('../../src/services/telegramService', {
  sendMessage: async () => {},
  sendMessageToGroup: async () => {},
  forwardMessage: async () => {},
});
stubModule('../../src/services/sessionService', {});
stubModule('../../src/services/reportService', { logActivity: async () => {} });
stubModule('../../src/queues/messageQueue', { addJob: async () => ({}) });
stubModule('../../src/utils/resolveSessions', { resolveSessionIdsFromRequest: async () => [] });
stubModule('../../src/services/sessionListService', {
  resolveSessionIds: async () => [],
});
stubModule('../../src/providers/telegram/riskScore', { gateOnRisk: async () => {} });
stubModule('../../src/config/telegram', { ANTI_REVOKE_PHASE_3_ENABLED: false });

const listService = require('../../src/services/listService');
const messageService = require('../../src/services/messageService');
const {
  parseCsvContent,
  parseJsonContent,
  coerceTelegramId,
  coerceUsername,
  detectContentFormat,
} = listService.__internal;
const { normalizeTargetId } = messageService.__internal;

let failures = 0;
function group(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}: ${err.message}`);
  }
}

group('coerceTelegramId', () => {
  assert.strictEqual(coerceTelegramId('5685747204'), '5685747204');
  assert.strictEqual(coerceTelegramId(5685747204), '5685747204');
  assert.strictEqual(coerceTelegramId('  838437059 '), '838437059');
  assert.strictEqual(
    coerceTelegramId('2617dd5b-57ae-4256-a002-03d1735134a8'),
    null,
    'UUID-style id must be rejected (no parseInt truncation)'
  );
  assert.strictEqual(coerceTelegramId(''), null);
  assert.strictEqual(coerceTelegramId(null), null);
  assert.strictEqual(coerceTelegramId('abc123'), null);
});

group('coerceUsername', () => {
  assert.strictEqual(coerceUsername('barry_keyes'), 'barry_keyes');
  assert.strictEqual(coerceUsername('@barry_keyes'), 'barry_keyes');
  assert.strictEqual(coerceUsername('  Cartio '), 'Cartio');
  assert.strictEqual(
    coerceUsername('5685747204'),
    null,
    'a purely numeric "username" is a stub, not a real handle'
  );
  assert.strictEqual(coerceUsername('8e4176f8-5c77-4be0-8691-ee11291af22a'), null);
  assert.strictEqual(coerceUsername(''), null);
  assert.strictEqual(coerceUsername(null), null);
});

group('detectContentFormat', () => {
  // CSV-in-.txt regression: the user uploaded a CSV with .txt extension.
  const csvHeader = 'telegram_id,username,first_name\n123,foo,bar\n';
  assert.strictEqual(detectContentFormat(csvHeader, '.txt', 'text/plain'), 'csv');
  assert.strictEqual(detectContentFormat(csvHeader, '.csv', 'text/csv'), 'csv');

  const json = '[{"telegram_id":1,"username":"x"}]';
  assert.strictEqual(detectContentFormat(json, '.json', 'application/json'), 'json');
  assert.strictEqual(detectContentFormat(json, '.txt', 'text/plain'), 'json');

  const txt = '@alice\n@bob\n+15551234567\n123456\n';
  assert.strictEqual(detectContentFormat(txt, '.txt', 'text/plain'), 'txt');

  // Unrecognised header should NOT be treated as CSV.
  const garbage = 'foo,bar,baz\n1,2,3\n';
  assert.strictEqual(detectContentFormat(garbage, '.txt', 'text/plain'), 'txt');
});

group('parseCsvContent (attached file shape)', () => {
  const csv = [
    'telegram_id,username,first_name,last_name,phone,is_bot,is_premium,scraped_at',
    '5685747204,5685747204,,,,,,',
    '2039376310,2039376310,Alessio,,,,,',
    '6901999029,,,,,,,',
    '7977832875,Ba_Alan,Alan Ba,,,,,',
    '2617dd5b-57ae-4256-a002-03d1735134a8,barry_keyes,Barry,,,,,',
    '8e4176f8-5c77-4be0-8691-ee11291af22a,8e4176f8-5c77-4be0-8691-ee11291af22a,Raul Sheard,,,,,',
    '24442c4c-ade2-4eab-b911-c68988dc6237,nickydtraponer0,Nick,,,,,',
  ].join('\n');

  const entries = parseCsvContent(csv);

  // We expect 6 usable rows; the all-UUID row is dropped.
  assert.strictEqual(
    entries.length, 6,
    `expected 6 usable rows; got ${entries.length}`
  );

  const byKey = (e) => e.telegram_id || `@${e.username}`;
  const keys = entries.map(byKey).sort();
  assert.deepStrictEqual(keys, [
    '2039376310',
    '5685747204',
    '6901999029',
    '7977832875',
    '@barry_keyes',
    '@nickydtraponer0',
  ]);

  const row5685 = entries.find((e) => e.telegram_id === '5685747204');
  assert.strictEqual(row5685.username, null);

  const rowBarry = entries.find((e) => e.username === 'barry_keyes');
  assert.strictEqual(rowBarry.telegram_id, null);
  assert.strictEqual(rowBarry.first_name, 'Barry');
});

group('parseJsonContent handles UUID ids', () => {
  const json = JSON.stringify([
    { telegram_id: 5685747204, username: '5685747204' },
    { telegram_id: '2617dd5b-57ae-4256-a002-03d1735134a8', username: 'barry_keyes' },
    { telegram_id: 'not-a-number', username: '8e4176f8-5c77-4be0-8691-ee11291af22a' },
  ]);
  const entries = parseJsonContent(json);
  assert.strictEqual(
    entries.length, 2,
    'rows with no usable id and no usable handle must be dropped'
  );
  assert.strictEqual(entries[0].telegram_id, '5685747204');
  assert.strictEqual(entries[1].telegram_id, null);
  assert.strictEqual(entries[1].username, 'barry_keyes');
});

group('normalizeTargetId', () => {
  // Pure numeric: passes through.
  assert.strictEqual(normalizeTargetId({ telegram_id: '5685747204' }), '5685747204');
  assert.strictEqual(normalizeTargetId(5685747204), '5685747204');

  // Numeric in `id`: still passes through.
  assert.strictEqual(normalizeTargetId({ id: 7977832875 }), '7977832875');

  // No id, but valid username -> @username so _resolveEntity uses
  // the username path.
  assert.strictEqual(
    normalizeTargetId({ telegram_id: null, username: 'barry_keyes' }),
    '@barry_keyes'
  );

  // UUID id + valid username -> falls back to @username.
  assert.strictEqual(
    normalizeTargetId({
      telegram_id: '2617dd5b-57ae-4256-a002-03d1735134a8',
      username: 'nickydtraponer0',
    }),
    '@nickydtraponer0'
  );

  // UUID id + UUID username -> null (entry is unaddressable).
  assert.strictEqual(
    normalizeTargetId({
      telegram_id: '8e4176f8-5c77-4be0-8691-ee11291af22a',
      username: '8e4176f8-5c77-4be0-8691-ee11291af22a',
    }),
    null
  );

  // Phone fallback.
  assert.strictEqual(
    normalizeTargetId({ telegram_id: null, username: null, phone: '15551234567' }),
    '+15551234567'
  );

  // String passthrough.
  assert.strictEqual(normalizeTargetId('@alice'), '@alice');
  assert.strictEqual(normalizeTargetId('5685747204'), '5685747204');

  // Bare UUID string -> null (would corrupt _resolveEntity).
  assert.strictEqual(
    normalizeTargetId('2617dd5b-57ae-4256-a002-03d1735134a8'),
    null
  );
});

if (failures > 0) {
  console.error(`\n${failures} test group(s) failed.`);
  process.exit(1);
}
console.log('\nAll listImport smoke tests passed.');
