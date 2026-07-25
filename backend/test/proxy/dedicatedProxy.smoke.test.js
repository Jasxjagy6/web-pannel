'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const service = require('../../src/services/dedicatedProxyService');

const source = (file) => fs.readFileSync(path.join(root, file), 'utf8');

(() => {
  const parse = service._internal.parseProxyUrl;
  assert.deepStrictEqual(parse('socks5://alice:secret@proxy.example:1080'), {
    host: 'proxy.example',
    port: 1080,
    protocol: 'socks5',
    username: 'alice',
    password: 'secret',
    label: null,
    country_code: null,
  });
  assert.deepStrictEqual(parse('proxy.example:1081:alice:secret'), {
    host: 'proxy.example',
    port: 1081,
    protocol: 'socks5',
    username: 'alice',
    password: 'secret',
    label: null,
    country_code: null,
  });
  assert.throws(() => parse('http://proxy.example:8080'), /SOCKS5 or MTProto/);

  const migration = source('src/config/migration_v55_dedicated_session_proxies.sql');
  assert.match(migration, /proxy_required BOOLEAN/);
  assert.match(migration, /UPDATE sessions SET proxy_required = FALSE/);
  assert.match(migration, /proxy_required SET DEFAULT TRUE/);
  assert.match(migration, /uq_session_proxy_dedicated_proxy/);

  const tg = source('src/services/telegramService.js');
  assert.match(tg, /resolveSessionProxy\(sessionId\)/);
  assert.match(tg, /if \(dedicatedResolution\.required && !entry\.proxy\)/);

  const login = source('src/services/sessionService.js');
  assert.match(login, /const proxyResolution = await dedicatedProxyService\.resolveSessionProxy/);

  const dedicated = source('src/services/dedicatedProxyService.js');
  assert.match(dedicated, /SESSION_PROXY_REQUIRED/);
  assert.match(dedicated, /SESSION_PROXY_UNHEALTHY/);

  const bulk = source('src/services/sessionBulkLoginService.js');
  assert.match(bulk, /proxyPlanId/);
  assert.match(bulk, /consumeLoginPlan/);

  console.log('dedicatedProxy.smoke.test: OK');
})();
