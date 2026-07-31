'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pool } = require('../../src/config/database');
const messageService = require('../../src/services/messageService');

const originalQuery = pool.query.bind(pool);

(async () => {
  try {
    let capturedSql = '';
    pool.query = async (sql) => {
      capturedSql = String(sql).replace(/\s+/g, ' ').trim();
      return {
        rows: [{
          id: 91001,
          user_id: 1,
          status: 'active',
          spam_status: 'limited',
          spam_limit_until: null,
        }],
      };
    };

    // Ordinary ownership checks back single-message/group/other features and
    // must keep Limited accounts available.
    const ordinary = await messageService._verifyMultipleSessionsOwnership([91001], 1);
    assert.strictEqual(ordinary.length, 1);
    assert.doesNotMatch(capturedSql, /spam_status = 'limited'/i);

    await messageService._verifyMultipleSessionsOwnership(
      [91001],
      1,
      { excludeLimited: true }
    );
    assert.match(capturedSql, /spam_status = 'limited'/i);
    assert.match(capturedSql, /spam_limit_until IS NULL OR spam_limit_until > NOW\(\)/i);

    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'services', 'messageService.js'),
      'utf8'
    );
    const method = (name, nextName) => {
      const start = source.indexOf(`async ${name}(`);
      const end = source.indexOf(`async ${nextName}(`, start + 1);
      assert.ok(start >= 0 && end > start, `could not isolate ${name}`);
      return source.slice(start, end);
    };

    assert.match(method('sendBulkMessage', 'sendFailoverMessage'), /excludeLimited:\s*true/);
    assert.match(method('sendFailoverMessage', '_runFailover'), /excludeLimited:\s*true/);
    assert.match(method('sendParallelMassDm', '_runParallelMassDm'), /excludeLimited:\s*true/);
    assert.match(method('sendBulkToUsers', '_processBulkUsers'), /excludeLimited:\s*true/);
    assert.doesNotMatch(method('sendSingleUserMassDm', '_processSingleUserMassDm'), /excludeLimited:\s*true/);

    // Bulk group, Single User DM, and regular single-message operations remain usable.
    assert.doesNotMatch(method('sendBulkToGroups', '_processBulkGroups'), /excludeLimited:\s*true/);
    assert.doesNotMatch(method('sendMessage', 'sendBulkMessage'), /excludeLimited:\s*true/);

    const spamBotSource = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'services', 'spamBotAppealService.js'),
      'utf8'
    );
    assert.match(spamBotSource, /sess\.classification !== 'frozen'/);
    assert.match(spamBotSource, /aiSessionManager'\)\.attach\(sid\)/);
    assert.match(spamBotSource, /otpRelayService'\)\.onSessionConnected\(sid\)/);

    const controllerSource = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'controllers', 'messageController.js'),
      'utf8'
    );
    const controllerFilterCalls = controllerSource.match(
      /sessionIds = await filterBulkDmSessionIds\(sessionIds, userId\)/g
    ) || [];
    assert.strictEqual(
      controllerFilterCalls.length,
      5,
      'bulk, failover, parallel, split, and preview must filter before queue/plan creation'
    );
    const singleUserControllerStart = controllerSource.indexOf('sendSingleUserMassDm:');
    const previewControllerStart = controllerSource.indexOf('previewBulk:', singleUserControllerStart);
    assert.doesNotMatch(
      controllerSource.slice(singleUserControllerStart, previewControllerStart),
      /filterBulkDmSessionIds/,
      'Single User DM must keep Limited sessions enabled'
    );

    console.log('spamLimitedMassDmPolicy.smoke.test: OK');
  } finally {
    pool.query = originalQuery;
  }
})().catch((err) => {
  pool.query = originalQuery;
  console.error(err);
  process.exit(1);
});
