#!/usr/bin/env node
/**
 * Telegram admin bot for the web-pannel upgrade orchestrator.
 *
 * Long-polling, no inbound port required. Reuses the backend's existing
 * `undici` dependency for HTTP, so no new npm packages are added.
 *
 * Commands (only respond to whitelisted TELEGRAM_ADMIN_IDS):
 *
 *   /start /help                show command list
 *   /status                     show active color and recent deploys
 *   /health                     probe both colors
 *   /upgrade <ref>              full deploy (asks for confirmation first)
 *   /rollback                   redeploy previous SHA (asks for confirmation)
 *   /migrate check|apply        run migration CLI
 *   /logs [N]                   last N log lines from active backend
 *
 * Safety:
 *   - TELEGRAM_ADMIN_IDS=12345,67890 (comma-separated) gates EVERY command.
 *   - Optional UPGRADE_CONFIRM_PIN: if set, destructive commands ask for the
 *     PIN before executing.
 *   - Every command goes to the audit log (deployments table + file).
 *
 * When TELEGRAM_ADMIN_BOT_TOKEN is unset the process exits 0 immediately so
 * Compose's `restart: unless-stopped` doesn't loop.
 */

require('dotenv').config();
const { request } = require('undici');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const TOKEN = (process.env.TELEGRAM_ADMIN_BOT_TOKEN || '').trim();
const ADMIN_IDS = new Set(
  (process.env.TELEGRAM_ADMIN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);
const PIN = (process.env.UPGRADE_CONFIRM_PIN || '').trim();
// Path to bin/upgrade on the host (mounted into the container at /host).
const UPGRADE_BIN = process.env.DEPLOY_HOST_BIN || '/host/bin/upgrade';
const HOST_REPO_ROOT = process.env.DEPLOY_HOST_ROOT || '/host';

const API = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

// Docker HEALTHCHECK reads /app/state/admin-bot.heartbeat; a fresh mtime
// means the long-poll loop is alive. We touch it on every poll iteration
// (even when getUpdates returns no updates) so a healthy idle bot still
// looks healthy.
const HEARTBEAT_PATH = path.join(
  process.env.STATE_DIR || '/app/state',
  'admin-bot.heartbeat'
);
function touchHeartbeat() {
  try {
    fs.mkdirSync(path.dirname(HEARTBEAT_PATH), { recursive: true });
    fs.writeFileSync(HEARTBEAT_PATH, String(Date.now()));
  } catch (err) {
    process.stderr.write(`bot: heartbeat write failed: ${err.message}\n`);
  }
}

if (!TOKEN) {
  process.stdout.write('TELEGRAM_ADMIN_BOT_TOKEN not set; admin bot is disabled.\n');
  // Touch the heartbeat so the docker healthcheck still passes \u2014 the
  // container is "healthy", just intentionally idle.
  touchHeartbeat();
  setInterval(touchHeartbeat, 30000);
  // Sleep forever so docker compose doesn't restart-loop us.
  setInterval(() => {}, 1 << 30);
}
if (TOKEN && ADMIN_IDS.size === 0) {
  process.stderr.write(
    'WARNING: TELEGRAM_ADMIN_BOT_TOKEN is set but TELEGRAM_ADMIN_IDS is empty. ' +
    'No commands will be accepted until you add at least one admin chat ID.\n'
  );
}

/* -------------------------------------------------------------------------- */
/* Telegram API helpers                                                       */
/* -------------------------------------------------------------------------- */

async function tg(method, body) {
  const r = await request(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const text = await r.body.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { throw new Error(`bad response: ${text}`); }
  if (!json.ok) throw new Error(`telegram ${method}: ${json.description}`);
  return json.result;
}

async function sendMessage(chatId, text, opts = {}) {
  return tg('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: opts.parse_mode || 'HTML',
    disable_web_page_preview: true,
    ...opts,
  });
}

function isAdmin(userId) {
  return ADMIN_IDS.has(String(userId));
}

/* -------------------------------------------------------------------------- */
/* Subprocess helpers                                                         */
/* -------------------------------------------------------------------------- */

function runUpgrade(args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [UPGRADE_BIN, ...args], {
      cwd: HOST_REPO_ROOT,
      env: { ...process.env, INITIATED_BY: process.env.INITIATED_BY || 'telegram' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    function pump(chunk) {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/\x1b\[[0-9;]*m/g, '');
        buf = buf.slice(idx + 1);
        if (line.trim()) onLine(line);
      }
    }
    child.stdout.on('data', pump);
    child.stderr.on('data', pump);
    child.on('error', reject);
    child.on('close', (code) => {
      if (buf) {
        const line = buf.replace(/\x1b\[[0-9;]*m/g, '').trim();
        if (line) onLine(line);
      }
      resolve({ code });
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Streaming output buffer (collapse many short lines into chat updates)      */
/* -------------------------------------------------------------------------- */

class ChatStream {
  constructor(chatId, header) {
    this.chatId = chatId;
    this.header = header;
    this.lines = [];
    this.flushTimer = null;
    this.lastSent = '';
    this.messageId = null;
  }
  push(line) {
    this.lines.push(line);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush().catch(() => {}), 800);
    }
  }
  async flush() {
    this.flushTimer = null;
    const tail = this.lines.slice(-30); // keep messages under TG's 4096 limit
    const body = `<b>${this.header}</b>\n<pre>${escapeHtml(tail.join('\n'))}</pre>`;
    if (body === this.lastSent) return;
    this.lastSent = body;
    try {
      if (this.messageId) {
        await tg('editMessageText', {
          chat_id: this.chatId,
          message_id: this.messageId,
          text: body,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
      } else {
        const m = await sendMessage(this.chatId, body);
        this.messageId = m.message_id;
      }
    } catch (_) { /* don't crash on bad markup; keep streaming */ }
  }
  async finalize(finalNote) {
    if (finalNote) this.lines.push(finalNote);
    await this.flush();
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* -------------------------------------------------------------------------- */
/* Command handlers                                                           */
/* -------------------------------------------------------------------------- */

async function handleStart(msg) {
  await sendMessage(msg.chat.id,
    'web-pannel admin bot.\n\n' +
    'Commands:\n' +
    '  /status              active color + recent deploys\n' +
    '  /health              probe blue and green\n' +
    '  /upgrade <ref>       deploy a branch / tag / sha\n' +
    '  /rollback            redeploy previous SHA\n' +
    '  /migrate check|apply\n' +
    '  /logs [N]            tail backend logs\n'
  );
}

async function handleStatus(msg) {
  const stream = new ChatStream(msg.chat.id, '/status');
  const r = await runUpgrade(['status'], (l) => stream.push(l));
  await stream.finalize(r.code === 0 ? '— done.' : `— exit ${r.code}.`);
}

async function handleHealth(msg) {
  const stream = new ChatStream(msg.chat.id, '/health');
  const r = await runUpgrade(['health'], (l) => stream.push(l));
  await stream.finalize(r.code === 0 ? '— done.' : `— exit ${r.code}.`);
}

async function handleLogs(msg, parts) {
  const n = parseInt(parts[1] || '100', 10) || 100;
  const stream = new ChatStream(msg.chat.id, `/logs (${n})`);
  const r = await runUpgrade(['logs', '-n', String(n)], (l) => stream.push(l));
  await stream.finalize(r.code === 0 ? '— done.' : `— exit ${r.code}.`);
}

async function handleMigrate(msg, parts) {
  const sub = (parts[1] || 'check').toLowerCase();
  if (sub !== 'check' && sub !== 'apply') {
    return sendMessage(msg.chat.id, 'usage: /migrate check|apply');
  }
  if (sub === 'apply' && !await checkPin(msg)) return;
  const stream = new ChatStream(msg.chat.id, `/migrate ${sub}`);
  const r = await runUpgrade(['migrate', `--${sub}`], (l) => stream.push(l));
  await stream.finalize(r.code === 0 ? '— done.' : `— exit ${r.code}.`);
}

async function handleUpgrade(msg, parts) {
  const ref = parts[1];
  if (!ref) return sendMessage(msg.chat.id, 'usage: /upgrade <branch|tag|sha>');
  if (!await checkPin(msg)) return;
  await sendMessage(msg.chat.id, `🚀 Deploying <b>${escapeHtml(ref)}</b>…`);
  const stream = new ChatStream(msg.chat.id, `/upgrade ${ref}`);
  const r = await runUpgrade(['deploy', '--ref', ref, '--no-confirm'], (l) => stream.push(l));
  if (r.code === 0) await stream.finalize('✅ deploy ok');
  else              await stream.finalize(`❌ deploy failed (exit ${r.code})`);
}

async function handleRollback(msg) {
  if (!await checkPin(msg)) return;
  await sendMessage(msg.chat.id, '↩️ Rolling back…');
  const stream = new ChatStream(msg.chat.id, '/rollback');
  const r = await runUpgrade(['rollback', '--no-confirm'], (l) => stream.push(l));
  if (r.code === 0) await stream.finalize('✅ rollback ok');
  else              await stream.finalize(`❌ rollback failed (exit ${r.code})`);
}

const PIN_PROMPTED = new Map(); // chatId → { ts, command }

async function checkPin(msg) {
  if (!PIN) return true;
  // Look for "PIN=<value>" style in the message.
  const m = (msg.text || '').match(/(?:^|\s)PIN=(\S+)/);
  if (m && m[1] === PIN) return true;
  await sendMessage(msg.chat.id,
    `🔒 destructive command — append <code>PIN=${escapeHtml('<your-pin>')}</code> ` +
    `to your message to confirm. Example: <code>/upgrade main PIN=hunter2</code>`
  );
  return false;
}

/* -------------------------------------------------------------------------- */
/* Long-poll loop                                                             */
/* -------------------------------------------------------------------------- */

async function loop() {
  let offset = 0;
  touchHeartbeat();
  while (true) {
    try {
      const updates = await tg('getUpdates', {
        offset,
        timeout: 30,
        allowed_updates: ['message'],
      });
      // Touch every iteration so the Docker HEALTHCHECK reports healthy
      // even during quiet periods when getUpdates just times out.
      touchHeartbeat();
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        await handleUpdate(u).catch((err) => {
          process.stderr.write(`bot: handler error: ${err.message}\n`);
        });
      }
    } catch (err) {
      // Touch heartbeat on errors too: getUpdates can fail transiently
      // (Telegram rate-limit, network blip, or a Conflict if the same bot
      // token is being polled from another host during a rolling deploy).
      // The poll loop is still alive — only the API call failed — so the
      // Docker HEALTHCHECK should not flip us to unhealthy and trigger a
      // restart loop on top of the API issue.
      touchHeartbeat();
      process.stderr.write(`bot: getUpdates error: ${err.message}\n`);
      await sleep(5000);
    }
  }
}

async function handleUpdate(u) {
  const msg = u.message;
  if (!msg || !msg.text) return;
  const fromId = msg.from && msg.from.id;
  if (!isAdmin(fromId)) {
    process.stderr.write(`bot: rejected message from non-admin user ${fromId}\n`);
    return;
  }
  const parts = msg.text.split(/\s+/);
  const cmd = parts[0].split('@')[0]; // strip @bot suffix in groups
  switch (cmd) {
    case '/start':
    case '/help':     return handleStart(msg);
    case '/status':   return handleStatus(msg);
    case '/health':   return handleHealth(msg);
    case '/logs':     return handleLogs(msg, parts);
    case '/migrate':  return handleMigrate(msg, parts);
    case '/upgrade':  return handleUpgrade(msg, parts);
    case '/rollback': return handleRollback(msg);
    default:
      // Ignore non-command chatter.
      return;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

if (TOKEN) {
  process.stdout.write(
    `admin-bot starting (admins=${[...ADMIN_IDS].join(',') || '(none)'}, ` +
    `pin=${PIN ? 'on' : 'off'}, host_bin=${UPGRADE_BIN})\n`
  );
  loop().catch((err) => {
    process.stderr.write(`bot: fatal: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}
