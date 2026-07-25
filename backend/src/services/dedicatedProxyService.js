'use strict';

const crypto = require('crypto');
const AdmZip = require('adm-zip');

const { pool } = require('../config/database');
const { AppError } = require('../utils/errorHandler');
const logger = require('../utils/logger');
const proxyService = require('./proxyService');

const PLAN_TTL_MS = 10 * 60 * 1000;
const HEALTH_INTERVAL_MS = 5 * 60 * 1000;
const IMPORT_CONCURRENCY = 8;
const plans = new Map();
let healthTimer = null;

function normalizeProtocol(value) {
  const protocol = String(value || 'socks5').trim().toLowerCase().replace(/:$/, '');
  if (!['socks5', 'mtproto'].includes(protocol)) {
    throw new AppError(
      'Telegram dedicated proxies must use SOCKS5 or MTProto. HTTP and SOCKS4 imports are not accepted for strict routing.',
      400,
      'PROXY_BAD_PROTOCOL'
    );
  }
  return protocol;
}

function parseProxyUrl(value, defaults = {}) {
  let raw = String(value || '').trim();
  if (!raw || raw.startsWith('#')) return null;

  const csvParts = raw.split(',').map((part) => part.trim());
  if (csvParts.length >= 2 && /^\d+$/.test(csvParts[1])) {
    return {
      host: csvParts[0],
      port: Number(csvParts[1]),
      username: csvParts[2] || null,
      password: csvParts[3] || null,
      protocol: normalizeProtocol(csvParts[4] || defaults.protocol),
      label: csvParts[5] || defaults.label || null,
      country_code: csvParts[6] || defaults.country_code || null,
    };
  }

  if (!raw.includes('://')) {
    const atMatch = raw.match(/^([^:@\s]+):([^@\s]+)@([^:\s]+):(\d{1,5})$/);
    if (atMatch) raw = `${defaults.protocol || 'socks5'}://${atMatch[1]}:${atMatch[2]}@${atMatch[3]}:${atMatch[4]}`;
    else {
      const parts = raw.split(':');
      if (parts.length === 4 && /^\d+$/.test(parts[1])) {
        raw = `${defaults.protocol || 'socks5'}://${encodeURIComponent(parts[2])}:${encodeURIComponent(parts[3])}@${parts[0]}:${parts[1]}`;
      } else if (parts.length === 2 && /^\d+$/.test(parts[1])) {
        raw = `${defaults.protocol || 'socks5'}://${parts[0]}:${parts[1]}`;
      }
    }
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AppError(`Invalid proxy entry: ${String(value).slice(0, 120)}`, 400, 'PROXY_IMPORT_INVALID');
  }
  const port = Number(parsed.port);
  if (!parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError(`Invalid proxy host or port: ${String(value).slice(0, 120)}`, 400, 'PROXY_IMPORT_INVALID');
  }
  return {
    host: parsed.hostname,
    port,
    protocol: normalizeProtocol(parsed.protocol),
    username: parsed.username ? decodeURIComponent(parsed.username) : null,
    password: parsed.password ? decodeURIComponent(parsed.password) : null,
    label: defaults.label || null,
    country_code: defaults.country_code || null,
  };
}

function recordsFromText(text, defaults = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    const values = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.proxies) ? parsed.proxies : [parsed]);
    return values.map((item) => {
      if (typeof item === 'string') return parseProxyUrl(item, defaults);
      if (!item || !item.host || !item.port) {
        throw new AppError('JSON proxy entries require host and port', 400, 'PROXY_IMPORT_INVALID');
      }
      return {
        host: String(item.host).trim(),
        port: Number(item.port),
        protocol: normalizeProtocol(item.protocol || defaults.protocol),
        username: item.username || null,
        password: item.password || null,
        label: item.label || defaults.label || null,
        country_code: item.country_code || item.country || defaults.country_code || null,
        notes: item.notes || null,
      };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
  }

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const first = String(lines[0] || '').toLowerCase();
  if (first.includes('host') && first.includes('port') && first.includes(',')) lines.shift();
  return lines.map((line) => parseProxyUrl(line, defaults)).filter(Boolean);
}

function recordsFromUpload(file, defaults = {}) {
  if (!file || !Buffer.isBuffer(file.buffer)) {
    throw new AppError('Proxy file is required', 400, 'PROXY_FILE_REQUIRED');
  }
  if (/\.zip$/i.test(file.originalname || '') || /zip/i.test(file.mimetype || '')) {
    const zip = new AdmZip(file.buffer);
    const records = [];
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory || !/\.(txt|csv|json)$/i.test(entry.entryName)) continue;
      records.push(...recordsFromText(entry.getData().toString('utf8'), defaults));
    }
    return records;
  }
  return recordsFromText(file.buffer.toString('utf8'), defaults);
}

async function importProxies(userId, file, defaults = {}) {
  const records = recordsFromUpload(file, defaults);
  if (records.length === 0) throw new AppError('No proxy records found in the upload', 400, 'PROXY_IMPORT_EMPTY');
  if (records.length > 5000) throw new AppError('A single import is limited to 5000 proxies', 400, 'PROXY_IMPORT_TOO_LARGE');

  const unique = Array.from(new Map(records.map((item) => [
    `${item.protocol}:${item.host}:${item.port}`.toLowerCase(), item,
  ])).values());
  const results = new Array(unique.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < unique.length) {
      const index = cursor++;
      const item = unique[index];
      try {
        const proxy = await proxyService.addMyProxy(userId, item);
        results[index] = { status: 'added', id: proxy.id, host: proxy.host, port: proxy.port, working: !!proxy.is_working };
      } catch (error) {
        results[index] = {
          status: error?.code === 'PROXY_DUPLICATE' ? 'duplicate' : 'failed',
          host: item.host,
          port: item.port,
          error: error.message,
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMPORT_CONCURRENCY, unique.length) }, () => worker()));
  return {
    total: unique.length,
    added: results.filter((item) => item.status === 'added').length,
    working: results.filter((item) => item.status === 'added' && item.working).length,
    duplicates: results.filter((item) => item.status === 'duplicate').length,
    failed: results.filter((item) => item.status === 'failed').length,
    results,
  };
}

async function resolveSessionProxy(sessionId) {
  const { rows } = await pool.query(
    `SELECT s.id, s.user_id, s.proxy_required,
            p.id AS proxy_id, p.user_id AS proxy_user_id, p.host, p.port,
            p.protocol, p.username, p.password_enc, p.secret, p.source,
            a.dedicated, p.enabled, p.is_working, p.validated_for_telegram, p.last_health_check,
            p.metadata
       FROM sessions s
       LEFT JOIN session_proxy_assignments a ON a.session_id = s.id
       LEFT JOIN proxies p ON p.id = a.proxy_id
      WHERE s.id = $1 AND s.platform = 'telegram'`,
    [sessionId]
  );
  const row = rows[0];
  if (!row) throw new AppError('Session not found', 404, 'SESSION_NOT_FOUND');
  if (!row.proxy_required) return { required: false, proxy: null, proxyConfig: null };
  if (!row.proxy_id || row.dedicated !== true) {
    throw new AppError('This session requires a dedicated proxy before login.', 412, 'SESSION_PROXY_REQUIRED');
  }
  if (
    row.proxy_user_id !== row.user_id || row.source !== 'user' || row.enabled !== true ||
    row.is_working !== true || row.validated_for_telegram !== true
  ) {
    throw new AppError('The session dedicated proxy is unavailable or failed its Telegram check.', 412, 'SESSION_PROXY_UNHEALTHY');
  }
  const proxyConfig = proxyService.buildGramJSProxy(row);
  if (!proxyConfig) {
    throw new AppError('The assigned proxy protocol cannot carry Telegram MTProto traffic.', 412, 'SESSION_PROXY_UNSUPPORTED');
  }
  return { required: true, proxy: row, proxyConfig };
}

async function sessionRowsForPlan(userId, { sessionIds, allInactive }) {
  let ids = Array.isArray(sessionIds)
    ? Array.from(new Set(sessionIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)))
    : [];
  if (allInactive) {
    const result = await pool.query(
      `SELECT id FROM sessions
        WHERE user_id = $1 AND platform = 'telegram' AND is_logged_in = FALSE
        ORDER BY id`,
      [userId]
    );
    ids = result.rows.map((row) => Number(row.id));
  }
  if (ids.length === 0) throw new AppError('No inactive sessions selected', 400, 'NO_SESSIONS');
  const result = await pool.query(
    `SELECT s.id, s.phone, s.proxy_required, s.bound_proxy_id, a.dedicated AS proxy_dedicated,
            p.host AS proxy_host, p.port AS proxy_port, p.protocol AS proxy_protocol,
            p.label AS proxy_label, p.country_code AS proxy_country_code,
            p.is_working AS proxy_is_working, p.enabled AS proxy_enabled,
            p.validated_for_telegram AS proxy_validated
       FROM sessions s
       LEFT JOIN session_proxy_assignments a ON a.session_id = s.id
       LEFT JOIN proxies p ON p.id = a.proxy_id AND p.id = s.bound_proxy_id
      WHERE s.user_id = $1 AND s.platform = 'telegram' AND s.id = ANY($2::int[])
      ORDER BY s.id`,
    [userId, ids]
  );
  return result.rows;
}

async function createLoginPlan(userId, request) {
  const sessions = await sessionRowsForPlan(userId, request || {});
  const available = (await pool.query(
    `SELECT p.id, p.host, p.port, p.protocol, p.label, p.country_code,
            p.last_latency_ms, p.metadata
       FROM proxies p
      WHERE p.user_id = $1 AND p.source = 'user' AND p.enabled = TRUE
        AND p.is_working = TRUE AND p.validated_for_telegram = TRUE
        AND p.protocol IN ('socks5', 'mtproto')
        AND NOT EXISTS (
          SELECT 1 FROM session_proxy_assignments a WHERE a.proxy_id = p.id
        )
        AND NOT EXISTS (
          SELECT 1
            FROM session_proxy_assignments used_a
            JOIN proxies used_p ON used_p.id = used_a.proxy_id
           WHERE NULLIF(used_p.metadata->>'egress_ip', '') IS NOT NULL
             AND used_p.metadata->>'egress_ip' = p.metadata->>'egress_ip'
        )
      ORDER BY p.last_latency_ms NULLS LAST, p.id`,
    [userId]
  )).rows;

  // A provider can expose several gateway ports that exit through the same
  // public IP. Treat those as one proxy so "1:1" means one real egress IP.
  const distinctAvailable = [];
  const seenEgress = new Set();
  for (const proxy of available) {
    const egress = String(proxy.metadata?.egress_ip || '').trim();
    const key = egress || `${proxy.host}:${proxy.port}`;
    if (seenEgress.has(key)) continue;
    seenEgress.add(key);
    distinctAvailable.push(proxy);
  }

  const mappings = [];
  let cursor = 0;
  for (const session of sessions) {
    if (!session.proxy_required) {
      mappings.push({
        sessionId: Number(session.id), phone: session.phone, proxyRequired: false,
        status: 'legacy_direct', proxy: null,
      });
      continue;
    }
    const existingHealthy = session.bound_proxy_id && session.proxy_dedicated === true && session.proxy_enabled === true &&
      session.proxy_is_working === true && session.proxy_validated === true;
    if (existingHealthy) {
      mappings.push({
        sessionId: Number(session.id), phone: session.phone, proxyRequired: true,
        status: 'already_bound',
        proxy: {
          id: Number(session.bound_proxy_id), host: session.proxy_host, port: session.proxy_port,
          protocol: session.proxy_protocol, label: session.proxy_label,
          countryCode: session.proxy_country_code,
        },
      });
      continue;
    }
    const proxy = distinctAvailable[cursor++] || null;
    mappings.push({
      sessionId: Number(session.id), phone: session.phone, proxyRequired: true,
      status: proxy ? 'ready_to_assign' : 'proxy_missing',
      proxy: proxy ? {
        id: Number(proxy.id), host: proxy.host, port: proxy.port, protocol: proxy.protocol,
        label: proxy.label, countryCode: proxy.country_code,
        egressIp: proxy.metadata?.egress_ip || null,
      } : null,
    });
  }

  const id = `proxy-plan-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
  const plan = { id, userId, createdAt: Date.now(), expiresAt: Date.now() + PLAN_TTL_MS, mappings };
  plans.set(id, plan);
  const timer = setTimeout(() => plans.delete(id), PLAN_TTL_MS);
  timer.unref?.();
  return publicPlan(plan);
}

function publicPlan(plan) {
  const mappings = plan.mappings;
  return {
    planId: plan.id,
    expiresAt: new Date(plan.expiresAt).toISOString(),
    summary: {
      total: mappings.length,
      legacyDirect: mappings.filter((item) => item.status === 'legacy_direct').length,
      alreadyBound: mappings.filter((item) => item.status === 'already_bound').length,
      readyToAssign: mappings.filter((item) => item.status === 'ready_to_assign').length,
      missingProxy: mappings.filter((item) => item.status === 'proxy_missing').length,
    },
    sessions: mappings,
  };
}

async function consumeLoginPlan(userId, planId, { skipUnassigned = false } = {}) {
  const plan = plans.get(planId);
  if (!plan || plan.userId !== userId || plan.expiresAt <= Date.now()) {
    plans.delete(planId);
    throw new AppError('Proxy assignment preview expired. Refresh the preview.', 409, 'PROXY_PLAN_EXPIRED');
  }
  const missing = plan.mappings.filter((item) => item.status === 'proxy_missing');
  if (missing.length > 0 && !skipUnassigned) {
    throw new AppError(`${missing.length} session(s) do not have a working proxy.`, 409, 'PROXY_SHORTAGE');
  }
  for (const item of plan.mappings) {
    if (item.status !== 'ready_to_assign' || !item.proxy) continue;
    try {
      await proxyService.assignUserProxyToSession(userId, item.sessionId, item.proxy.id, {
        dedicated: true,
        requireHealthy: true,
      });
    } catch (error) {
      logger.warn('Dedicated proxy plan became stale', { planId, sessionId: item.sessionId, error: error.message });
      throw new AppError('A proxy became unavailable. Refresh the assignment preview.', 409, 'PROXY_PLAN_STALE');
    }
  }
  plans.delete(planId);
  return {
    sessionIds: plan.mappings
      .filter((item) => item.status !== 'proxy_missing' || !skipUnassigned)
      .filter((item) => item.status !== 'proxy_missing')
      .map((item) => item.sessionId),
    mappings: plan.mappings,
    skipped: missing.map((item) => item.sessionId),
  };
}

async function revalidateAll(userId = null) {
  const params = [];
  const userClause = userId ? 'AND user_id = $1' : '';
  if (userId) params.push(userId);
  const rows = (await pool.query(
    `SELECT id, user_id FROM proxies
      WHERE source = 'user' AND enabled = TRUE AND user_id IS NOT NULL
        ${userClause}
      ORDER BY id`
    , params)).rows;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(10, Math.max(1, rows.length)) }, async () => {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      await proxyService.testMyProxy(row.user_id, row.id).catch((error) => {
        logger.debug(`Dedicated proxy health check failed for ${row.id}: ${error.message}`);
      });
    }
  });
  await Promise.all(workers);
  return { checked: rows.length };
}

function startHealthMonitor() {
  if (healthTimer) return;
  setTimeout(() => revalidateAll().catch((error) => logger.warn(`Proxy health pass failed: ${error.message}`)), 5000).unref?.();
  healthTimer = setInterval(
    () => revalidateAll().catch((error) => logger.warn(`Proxy health pass failed: ${error.message}`)),
    HEALTH_INTERVAL_MS
  );
  healthTimer.unref?.();
  logger.info('Dedicated proxy health monitor started (5 minute interval)');
}

module.exports = {
  importProxies,
  resolveSessionProxy,
  createLoginPlan,
  consumeLoginPlan,
  revalidateAll,
  startHealthMonitor,
  _plans: plans,
  _internal: { parseProxyUrl, recordsFromText, recordsFromUpload },
};
