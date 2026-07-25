'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pool } = require('../../src/config/database');
const sessionListService = require('../../src/services/sessionListService');

const originalQuery = pool.query.bind(pool);
const originalConnect = pool.connect.bind(pool);

const serviceSource = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'services', 'sessionListService.js'),
  'utf8'
);
const controllerSource = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'controllers', 'sessionListController.js'),
  'utf8'
);
const routeSource = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'routes', 'sessionLists.js'),
  'utf8'
);

assert.match(serviceSource, /async function organizeBySpamStatus/);
assert.match(serviceSource, /\['limited', 'frozen'\]\.includes/);
assert.match(serviceSource, /COALESCE\(spam_status, 'unknown'\) = \$2/);
assert.match(serviceSource, /systemKey = `spam_status:\$\{normalized\}`/);
assert.match(serviceSource, /AND system_key = \$2/);
assert.doesNotMatch(serviceSource, /system_key = \$2 OR lower\(name\)/);
assert.match(serviceSource, /while \(usedNames\.has\(name\.toLowerCase\(\)\)\)/);
assert.match(serviceSource, /DELETE FROM session_list_members WHERE list_id = \$1/);
assert.match(serviceSource, /UNNEST\(\$2::int\[\]\)/);
assert.match(serviceSource, /const MAX_SESSIONS_PER_LIST = 10000/);
assert.doesNotMatch(
  serviceSource.slice(
    serviceSource.indexOf('async function organizeBySpamStatus'),
    serviceSource.indexOf('async function addSessions')
  ),
  /is_logged_in|warmup_state/,
  'managed status lists must mirror every persisted session, not only active sessions'
);
assert.match(controllerSource, /organizeSpamStatus:/);
assert.match(routeSource, /router\.post\('\/organize-spam-status', ctrl\.organizeSpamStatus\)/);

(async () => {
  let selectedSql = '';
  let insertedIds = [];
  const query = async (sql, params = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }
    if (text.startsWith('SELECT id FROM sessions')) {
      selectedSql = text;
      assert.deepStrictEqual(params, [7, 'limited']);
      return { rows: [{ id: 10 }, { id: 11 }], rowCount: 2 };
    }
    if (text.startsWith('SELECT id FROM session_lists')) {
      assert.deepStrictEqual(params, [7, 'spam_status:limited']);
      return { rows: [], rowCount: 0 };
    }
    if (text.startsWith('SELECT lower(name) AS name FROM session_lists')) {
      return { rows: [{ name: 'all limited sessions' }], rowCount: 1 };
    }
    if (text.startsWith('INSERT INTO session_lists')) {
      assert.strictEqual(params[1], 'All Limited Sessions (Managed)');
      assert.strictEqual(params[3], 'spam_status:limited');
      return { rows: [{ id: 88 }], rowCount: 1 };
    }
    if (text.startsWith('DELETE FROM session_list_members')) {
      assert.deepStrictEqual(params, [88]);
      return { rows: [], rowCount: 2 };
    }
    if (text.startsWith('INSERT INTO session_list_members')) {
      insertedIds = params[1];
      return { rows: [], rowCount: insertedIds.length };
    }
    if (text.startsWith('SELECT sl.id, sl.user_id')) {
      return {
        rows: [{
          id: 88,
          user_id: 7,
          platform: 'telegram',
          name: 'All Limited Sessions (Managed)',
          description: 'managed',
          system_key: 'spam_status:limited',
          session_count: 2,
        }],
        rowCount: 1,
      };
    }
    throw new Error(`Unexpected SQL: ${text}`);
  };

  pool.query = query;
  pool.connect = async () => ({ query, release() {} });
  try {
    const list = await sessionListService.organizeBySpamStatus({ userId: 7, status: 'limited' });
    assert.strictEqual(list.id, 88);
    assert.strictEqual(list.matched_count, 2);
    assert.deepStrictEqual(insertedIds, [10, 11]);
    assert.doesNotMatch(selectedSql, /is_logged_in|warmup_state/);
    console.log('sessionListSpamOrganizer.smoke.test: OK');
  } finally {
    pool.query = originalQuery;
    pool.connect = originalConnect;
  }
})().catch((error) => {
  pool.query = originalQuery;
  pool.connect = originalConnect;
  console.error(error);
  process.exit(1);
});
