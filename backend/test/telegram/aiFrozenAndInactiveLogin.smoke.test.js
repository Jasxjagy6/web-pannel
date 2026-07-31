'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pool } = require('../../src/config/database');
const sessionService = require('../../src/services/sessionService');

const root = path.join(__dirname, '..', '..');

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

(() => {
  const aiService = source('src/services/aiChatService.js');
  assert.match(aiService, /FROZEN_SESSION_AI_DISABLED/);
  assert.match(aiService, /session_frozen/);
  assert.match(aiService, /_forceFrozenOff/);
  assert.match(aiService, /SET enabled = FALSE/);

  const manager = source('src/services/aiSessionManager.js');
  assert.match(manager, /spam_status === 'frozen'/);
  assert.ok(
    manager.indexOf("spam_status === 'frozen'") < manager.indexOf("this._sessions.has(sid)"),
    'frozen guard must run before the already-attached shortcut'
  );

  const worker = source('src/workers/aiChatWorker.js');
  assert.ok(
    (worker.match(/spam_status === 'frozen'/g) || []).length >= 2,
    'worker must check frozen status before generation and again before send'
  );

  const frontend = source('../frontend/src/pages/AiChat.jsx');
  assert.match(frontend, /Frozen · AI locked OFF/);
  assert.match(frontend, /!s\.isLoggedIn \|\| frozen/);
})();

const originalQuery = pool.query.bind(pool);
const originalLogin = sessionService.loginSession;
const attempted = [];

pool.query = async (sql, params = []) => {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  if (text.startsWith('SELECT id FROM sessions')) {
    return { rows: [{ id: 101 }, { id: 102 }] };
  }
  if (text.startsWith('SELECT id, phone FROM sessions')) {
    return { rows: [{ id: 101, phone: '+101' }, { id: 102, phone: '+102' }] };
  }
  if (text.startsWith('SELECT id, phone, is_logged_in FROM sessions')) {
    const id = Number(params[0]);
    return { rows: [{ id, phone: `+${id}`, is_logged_in: id === 102 }] };
  }
  throw new Error(`Unexpected SQL: ${text}`);
};

sessionService.loginSession = async (sessionId) => {
  attempted.push(Number(sessionId));
  return { accountInfo: { phone: `+${sessionId}` } };
};

(async () => {
  try {
    delete require.cache[require.resolve('../../src/services/sessionBulkLoginService')];
    const bulkLogin = require('../../src/services/sessionBulkLoginService');
    const started = await bulkLogin.startBulkLoginJob({
      userId: 1,
      allInactive: true,
      interRowDelayMs: 0,
    });
    assert.strictEqual(started.total, 2);

    let view;
    for (let i = 0; i < 50; i++) {
      view = bulkLogin.getJobStatus(started.jobId, 1);
      if (view?.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.strictEqual(view.status, 'completed');
    assert.deepStrictEqual(attempted, [101], 'already logged-in session must be skipped');
    assert.strictEqual(view.summary.succeeded, 1);
    assert.strictEqual(view.summary.alreadyLoggedIn, 1);
    console.log('aiFrozenAndInactiveLogin.smoke.test: OK');
  } finally {
    pool.query = originalQuery;
    sessionService.loginSession = originalLogin;
  }
})().catch((error) => {
  pool.query = originalQuery;
  sessionService.loginSession = originalLogin;
  console.error(error);
  process.exit(1);
});
