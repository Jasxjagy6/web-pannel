'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.USERNAME_VALIDATION_DELAY_MIN_MS = '0';
process.env.USERNAME_VALIDATION_DELAY_MAX_MS = '0';

const { pool } = require('../../src/config/database');
const telegramService = require('../../src/services/telegramService');
const service = require('../../src/services/usernameValidationService');

const originalQuery = pool.query.bind(pool);
const originalConnect = pool.connect.bind(pool);
const originalResolve = telegramService.resolveUsernameLive.bind(telegramService);

(async () => {
  try {
    const { normalizeUsernameCandidate, normalizeSessionListIds, classifyResolveError } = service.__internal;

    assert.deepStrictEqual(normalizeUsernameCandidate('@Real_User'), {
      username: 'Real_User',
      normalized: 'real_user',
    });
    assert.deepStrictEqual(normalizeUsernameCandidate('https://t.me/Real_User?start=1'), {
      username: 'Real_User',
      normalized: 'real_user',
    });
    assert.strictEqual(normalizeUsernameCandidate('not a username'), null);
    assert.deepStrictEqual(
      normalizeSessionListIds(3, [2, '1', 2, 0, 'bad']),
      [2, 1, 3],
      'multiple session lists must be de-duplicated without losing selection order'
    );

    assert.strictEqual(
      classifyResolveError(new Error('USERNAME_NOT_OCCUPIED')).kind,
      'invalid_username'
    );
    assert.strictEqual(
      classifyResolveError(new Error('A wait of 12 seconds is required (caused by contacts.ResolveUsername) FLOOD_WAIT_12')).kind,
      'session_failure'
    );
    assert.deepStrictEqual(
      classifyResolveError(new Error('A wait of 47 seconds is required (caused by contacts.ResolveUsername)')),
      { kind: 'session_failure', code: 'FLOOD_WAIT_47', retryAfterSeconds: 47 }
    );
    assert.strictEqual(
      classifyResolveError(new Error('PEER_FLOOD')).kind,
      'session_failure'
    );
    assert.strictEqual(
      classifyResolveError(new Error('Some unrelated RPC problem')).kind,
      'item_failure',
      'unknown target errors must not retire a healthy session'
    );

    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'services', 'usernameValidationService.js'),
      'utf8'
    );
    const sessionListSource = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'services', 'sessionListService.js'),
      'utf8'
    );
    const telegramSource = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'services', 'telegramService.js'),
      'utf8'
    );

    assert.match(source, /includeFrozen:\s*false/);
    assert.doesNotMatch(source, /excludeLimited/);
    assert.match(source, /sessionListIds/);
    assert.match(source, /status = 'waiting'/);
    assert.match(source, /retry_pass_used/);
    assert.match(source, /retry_after_flood_wait/);
    assert.match(sessionListSource, /spam_status,\s*\n\s*s\.spam_limit_until/);
    assert.match(sessionListSource, /spam_status, 'unknown'\) <> 'frozen'/);
    assert.doesNotMatch(sessionListSource, /spam_status[^\n]*<> 'limited'/);
    assert.match(telegramSource, /new Api\.contacts\.ResolveUsername\(\{ username \}\)/);

    const validatorStart = telegramSource.indexOf('async resolveUsernameLive(');
    const validatorEnd = telegramSource.indexOf('\n  /**', validatorStart + 1);
    const validatorMethod = telegramSource.slice(
      validatorStart,
      validatorEnd > validatorStart ? validatorEnd : validatorStart + 2500
    );
    assert.doesNotMatch(validatorMethod, /sendMessage|ImportContacts|SendMessage/);

    // End-to-end worker failover with an in-memory DB stub. Session 71 is
    // explicitly SpamBot Limited and must still be attempted first. Telegram
    // then returns FLOOD_WAIT, so the same username must move to session 72.
    const item = {
      id: 501,
      username: 'real_user',
      normalized_username: 'real_user',
      status: 'pending',
      attempts: 0,
    };
    const state = {
      finalStatus: null,
      valid: 0,
      listItems: 0,
      retired: [],
      waitingAt: null,
      skipped: 0,
    };
    const resolveCalls = [];

    const query = async (sql, params = []) => {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith('SELECT cancel_requested FROM username_validation_jobs')) {
        return { rows: [{ cancel_requested: false }] };
      }
      if (text.startsWith('SELECT id, username, normalized_username FROM username_validation_items')) {
        return { rows: item.status === 'pending' ? [{ ...item }] : [] };
      }
      if (text.includes("SET status = 'running', session_id")) {
        item.status = 'running';
        item.attempts++;
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('SET current_username = $2, current_session_id = $3')) {
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('SET retired_sessions = $2::jsonb')) {
        state.retired = JSON.parse(params[1]);
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("SET status = 'waiting', retry_at = $2")) {
        state.finalStatus = 'waiting';
        state.waitingAt = params[1];
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("SET status = 'skipped', error_code = $2")) {
        if (item.status === 'pending' || item.status === 'running') {
          item.status = 'skipped';
          state.skipped++;
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('SET skipped_count = skipped_count + $2')) {
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("SET status = 'pending', error_code = $2")) {
        item.status = 'pending';
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith('INSERT INTO list_items')) {
        state.listItems++;
        return { rows: [{ id: 801 }], rowCount: 1 };
      }
      if (text.includes("SET status = 'valid', result_list_item_id")) {
        item.status = 'valid';
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith('UPDATE lists SET items_count = items_count + 1')) {
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('SET processed_count = processed_count + 1') && text.includes('valid_count')) {
        state.valid++;
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('SET status = $2, error_message = $3, current_username = NULL')) {
        state.finalStatus = params[1];
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL in username validation test: ${text}`);
    };

    pool.query = query;
    pool.connect = async () => ({ query, release() {} });
    telegramService.resolveUsernameLive = async (sessionId, username) => {
      resolveCalls.push({ sessionId: Number(sessionId), username });
      if (Number(sessionId) === 71) {
        const error = new Error('FLOOD_WAIT_30');
        error.errorMessage = 'FLOOD_WAIT_30';
        throw error;
      }
      return {
        telegramId: '123456789',
        accessHash: '7654321',
        username,
        firstName: 'Real',
        lastName: 'User',
        phone: null,
        isBot: false,
        isPremium: false,
      };
    };

    await service._processJob({
      id: 9001,
      user_id: 1,
      result_list_id: 88,
      total_count: 1,
      selected_sessions: [
        { id: 71, spamStatus: 'limited' },
        { id: 72, spamStatus: 'clean' },
      ],
      retired_sessions: [],
    });

    assert.deepStrictEqual(resolveCalls, [
      { sessionId: 71, username: 'real_user' },
      { sessionId: 72, username: 'real_user' },
    ]);
    assert.strictEqual(state.retired.length, 1);
    assert.strictEqual(state.retired[0].id, 71);
    assert.match(state.retired[0].code, /FLOOD_WAIT/);
    assert.strictEqual(item.attempts, 2, 'the same username must be retried after failover');
    assert.strictEqual(state.listItems, 1);
    assert.strictEqual(state.valid, 1);
    assert.strictEqual(state.finalStatus, 'completed');

    // First exhaustion with retry enabled must enter waiting and preserve the
    // pending username. The final retry pass is allowed exactly once; if every
    // session floods again, it becomes terminal exhausted and skips the
    // remaining row rather than creating a retry loop.
    item.status = 'pending';
    item.attempts = 0;
    state.finalStatus = null;
    state.retired = [];
    state.waitingAt = null;
    state.skipped = 0;
    resolveCalls.length = 0;
    telegramService.resolveUsernameLive = async (sessionId, username) => {
      resolveCalls.push({ sessionId: Number(sessionId), username });
      const error = new Error(`FLOOD_WAIT_${Number(sessionId) === 71 ? 30 : 60}`);
      error.errorMessage = error.message;
      throw error;
    };

    const retryJob = {
      id: 9002,
      user_id: 1,
      result_list_id: 89,
      total_count: 1,
      selected_sessions: [{ id: 71 }, { id: 72 }],
      retired_sessions: [],
      retry_after_flood_wait: true,
      retry_pass_used: false,
    };
    await service._processJob(retryJob);
    assert.strictEqual(state.finalStatus, 'waiting');
    assert.ok(state.waitingAt instanceof Date);
    assert.strictEqual(item.status, 'pending', 'waiting must preserve the resume item');
    assert.deepStrictEqual(resolveCalls.map((call) => call.sessionId), [71, 72]);

    state.finalStatus = null;
    retryJob.retired_sessions = [];
    retryJob.retry_pass_used = true;
    await service._processJob(retryJob);
    assert.strictEqual(state.finalStatus, 'exhausted');
    assert.strictEqual(state.skipped, 1);
    assert.strictEqual(item.status, 'skipped');

    const controllerSource = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'controllers', 'usernameValidationController.js'),
      'utf8'
    );
    assert.match(controllerSource, /sessionListIds:\s*req\.body\?\.sessionListIds/);
    assert.match(controllerSource, /retryAfterFloodWait:\s*req\.body\?\.retryAfterFloodWait === true/);

    const migrationSource = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'config', 'migration_v53_username_validation_retry_and_managed_lists.sql'),
      'utf8'
    );
    assert.match(migrationSource, /'waiting'/);
    assert.match(migrationSource, /WHERE status IN \('pending', 'running', 'waiting'\)/);
    assert.match(migrationSource, /system_key/);

    console.log('usernameValidation.smoke.test: OK');
  } finally {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    telegramService.resolveUsernameLive = originalResolve;
  }
})().catch((error) => {
  pool.query = originalQuery;
  pool.connect = originalConnect;
  telegramService.resolveUsernameLive = originalResolve;
  console.error(error);
  process.exit(1);
});
