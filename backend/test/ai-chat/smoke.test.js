/**
 * Smoke test for the AI auto-responder modules.
 *
 * Verifies that the new services, worker, queue, controller, and route
 * modules can be required without throwing.  Full integration tests would
 * need a live GramJS session and a CupidBot token.
 */

const assert = require('assert');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

console.log('AI chat module smoke tests');

test('cupidbotService loads', () => {
  const svc = require('../../src/services/cupidbotService');
  assert.ok(svc, 'cupidbotService should export an object');
  assert.strictEqual(typeof svc.generateReply, 'function', 'generateReply should be a function');
});

test('aiMemoryService loads', () => {
  const svc = require('../../src/services/aiMemoryService');
  assert.ok(svc, 'aiMemoryService should export an object');
  assert.strictEqual(typeof svc.append, 'function', 'append should be a function');
});

test('aiChatService loads', () => {
  const svc = require('../../src/services/aiChatService');
  assert.ok(svc, 'aiChatService should export an object');
  assert.strictEqual(typeof svc.handleIncomingMessage, 'function', 'handleIncomingMessage should be a function');
});

test('aiSessionManager loads', () => {
  const svc = require('../../src/services/aiSessionManager');
  assert.ok(svc, 'aiSessionManager should export an object');
  assert.strictEqual(typeof svc.attach, 'function', 'attach should be a function');
});

test('aiChatQueue loads', () => {
  const q = require('../../src/queues/aiChatQueue');
  assert.ok(q, 'aiChatQueue should export an object');
});

test('aiChatWorker loads', () => {
  const w = require('../../src/workers/aiChatWorker');
  assert.ok(w, 'aiChatWorker should export an object');
  assert.strictEqual(typeof w.start, 'function', 'start should be a function');
});

test('aiChatController loads', () => {
  const c = require('../../src/controllers/aiChatController');
  assert.ok(c, 'aiChatController should export an object');
  assert.strictEqual(typeof c.getSessionSettings, 'function', 'getSessionSettings should be a function');
});

test('aiChat routes load', () => {
  const r = require('../../src/routes/aiChat');
  assert.ok(r, 'aiChat routes should export a router');
});

console.log('All AI chat smoke tests passed.');
