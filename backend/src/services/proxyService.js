/**
 * ProxyService - Dynamic proxy pool for Telegram MTProto connections.
 *
 * Responsibilities:
 *   - Scrape free SOCKS5/HTTP proxies from public open-source lists
 *   - Validate proxies against Telegram MTProto endpoints
 *   - Maintain up to FREE_PROXY_POOL_SIZE working free proxies
 *   - Re-validate every PROXY_RECHECK_INTERVAL_MS and prune dead ones
 *   - Manage manually-added (paid) proxies with top priority
 *   - Assign proxies to sessions enforcing MAX_SESSIONS_PER_PROXY (default 4)
 *
 * Public API:
 *   listProxies(filter), addManualProxy(payload), deleteProxy(id),
 *   refreshFreeProxies(), assignProxyForSession(sessionId), releaseProxy(sessionId),
 *   getProxyForSession(sessionId), buildGramJSProxy(proxy)
 */

const { pool } = require('../config/database');
const logger = require('../utils/logger');
const { encrypt, decrypt } = require('../utils/crypto');
const { AppError } = require('../utils/errorHandler');
const net = require('net');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const FREE_PROXY_POOL_SIZE = 20;
const MAX_SESSIONS_PER_PROXY = 4;
const PROXY_RECHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const PROXY_VALIDATION_TIMEOUT_MS = 8000;
const TELEGRAM_PROBE_HOST = '149.154.167.51'; // Telegram DC4 IPv4
const TELEGRAM_PROBE_PORT = 443;
const MAX_CANDIDATE_BATCH = 200;

// Free proxy lists - reasonably reliable open source sources.
const FREE_PROXY_SOURCES = [
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
  'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt',
  'https://raw.githubusercontent.com/zloi-user/hideip.me/main/socks5.txt',
];

/**
 * Sleep helper.
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch a URL and return the body as a string.
 * @param {string} url
 * @returns {Promise<string>}
 */
function fetchText(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('fetch timeout')));
    req.on('error', reject);
  });
}

/**
 * Parse a `host:port` line into a candidate.
 */
function parseCandidate(line, defaultProtocol = 'socks5') {
  const trimmed = String(line || '').trim().split(/\s+/)[0];
  if (!trimmed) return null;
  const m = trimmed.match(/^(?:(socks5|socks4|http|https):\/\/)?([\w.\-]+):(\d{2,5})$/i);
  if (!m) return null;
  const protocol = (m[1] || defaultProtocol).toLowerCase();
  const host = m[2];
  const port = parseInt(m[3], 10);
  if (!host || !port || port > 65535) return null;
  return { host, port, protocol };
}

/**
 * Probe a proxy by trying to open a SOCKS5 tunnel to Telegram's IP.
 *
 * For SOCKS5 we issue a minimal greeting + CONNECT to the Telegram DC.
 * For other protocols we fall back to a plain TCP connect to host:port
 * to at least confirm reachability (used as a smoke test).
 *
 * @param {{host:string, port:number, protocol:string}} proxy
 * @returns {Promise<{ok:boolean, latencyMs:number}>}
 */
function probeProxy(proxy) {
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = new net.Socket();
    let settled = false;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* noop */ }
      resolve({ ok, latencyMs: Date.now() - start });
    };

    const fail = () => finish(false);

    sock.setTimeout(PROXY_VALIDATION_TIMEOUT_MS);
    sock.once('timeout', fail);
    sock.once('error', fail);

    sock.connect(proxy.port, proxy.host, () => {
      if (proxy.protocol === 'socks5') {
        // SOCKS5 greeting: VER=5, NMETHODS=1, METHOD=NO_AUTH(0)
        sock.write(Buffer.from([0x05, 0x01, 0x00]));
        sock.once('data', (data) => {
          // Expect VER=5, METHOD=0
          if (data.length < 2 || data[0] !== 0x05 || data[1] !== 0x00) {
            return fail();
          }
          // CONNECT request: VER=5, CMD=1, RSV=0, ATYP=1(IPv4), DST.ADDR(4), DST.PORT(2)
          const ip = TELEGRAM_PROBE_HOST.split('.').map((p) => parseInt(p, 10));
          const portBuf = Buffer.alloc(2);
          portBuf.writeUInt16BE(TELEGRAM_PROBE_PORT, 0);
          const req = Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x01]),
            Buffer.from(ip),
            portBuf,
          ]);
          sock.write(req);
          sock.once('data', (resp) => {
            // Reply: VER=5, REP=0(success)
            if (resp.length >= 2 && resp[0] === 0x05 && resp[1] === 0x00) {
              return finish(true);
            }
            return fail();
          });
        });
      } else {
        // For non-SOCKS5 (http/socks4), confirming TCP reachability is the
        // best portable smoke test. Real MTProto validation happens when
        // a session actually attempts to connect via this proxy.
        finish(true);
      }
    });
  });
}

/**
 * Probe with an overall timeout safety net.
 */
async function probeWithTimeout(proxy) {
  return Promise.race([
    probeProxy(proxy),
    new Promise((resolve) =>
      setTimeout(() => resolve({ ok: false, latencyMs: PROXY_VALIDATION_TIMEOUT_MS }), PROXY_VALIDATION_TIMEOUT_MS + 500)
    ),
  ]);
}

class ProxyService {
  constructor() {
    /** @type {NodeJS.Timeout|null} */
    this._recheckTimer = null;
    this._scrapeInFlight = false;
  }

  // =========================================================================
  // Background scheduling
  // =========================================================================

  startBackground() {
    if (this._recheckTimer) return;
    logger.info('ProxyService background scheduler starting');
    // Initial async tick - don't block startup.
    setTimeout(() => this._tick().catch((e) => logger.error('proxy initial tick failed', { error: e.message })), 5000);
    this._recheckTimer = setInterval(
      () => this._tick().catch((e) => logger.error('proxy tick failed', { error: e.message })),
      PROXY_RECHECK_INTERVAL_MS
    );
  }

  stopBackground() {
    if (this._recheckTimer) {
      clearInterval(this._recheckTimer);
      this._recheckTimer = null;
    }
  }

  async _tick() {
    await this.revalidateAll();
    await this.refreshFreeProxies();
  }

  // =========================================================================
  // CRUD - Manual / Free proxies
  // =========================================================================

  /**
   * List proxies, optionally filtered.
   * @param {{source?:string, working?:boolean}} [filter]
   */
  async listProxies(filter = {}) {
    const conditions = [];
    const params = [];
    if (filter.source) {
      params.push(filter.source);
      conditions.push(`source = $${params.length}`);
    }
    if (typeof filter.working === 'boolean') {
      params.push(filter.working);
      conditions.push(`is_working = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT id, host, port, protocol, username, source, is_working, priority,
              active_assignments, total_assignments, last_checked_at,
              last_failed_at, last_latency_ms, consecutive_failures, metadata,
              created_at
       FROM proxies
       ${where}
       ORDER BY priority DESC, last_latency_ms NULLS LAST, id ASC`,
      params
    );
    return result.rows.map((r) => ({ ...r, hasPassword: !!r.password_enc }));
  }

  /**
   * Add a manually-supplied proxy. Manual proxies get top priority over free.
   *
   * @param {{host:string,port:number,protocol?:string,username?:string,password?:string,secret?:string,priority?:number}} payload
   */
  async addManualProxy(payload) {
    if (!payload || !payload.host || !payload.port) {
      throw new AppError('host and port are required', 400, 'PROXY_INVALID');
    }
    const protocol = (payload.protocol || 'socks5').toLowerCase();
    if (!['socks5', 'socks4', 'http', 'https', 'mtproto'].includes(protocol)) {
      throw new AppError('Unsupported proxy protocol', 400, 'PROXY_BAD_PROTOCOL');
    }
    const port = parseInt(payload.port, 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      throw new AppError('Invalid port', 400, 'PROXY_BAD_PORT');
    }

    const passwordEnc = payload.password ? encrypt(String(payload.password)) : null;

    const insert = await pool.query(
      `INSERT INTO proxies
        (host, port, protocol, username, password_enc, secret,
         source, priority, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,'manual',$7,$8)
       ON CONFLICT (host, port, protocol) DO UPDATE SET
         username = EXCLUDED.username,
         password_enc = EXCLUDED.password_enc,
         secret = EXCLUDED.secret,
         source = 'manual',
         priority = EXCLUDED.priority,
         metadata = EXCLUDED.metadata
       RETURNING id`,
      [
        payload.host,
        port,
        protocol,
        payload.username || null,
        passwordEnc,
        payload.secret || null,
        payload.priority != null ? Number(payload.priority) : 500,
        payload.metadata ? JSON.stringify(payload.metadata) : null,
      ]
    );

    const proxyId = insert.rows[0].id;
    // Probe the new proxy immediately.
    const probe = await probeWithTimeout({ host: payload.host, port, protocol });
    await pool.query(
      `UPDATE proxies SET is_working = $1, last_checked_at = NOW(),
              last_latency_ms = $2,
              consecutive_failures = CASE WHEN $1 THEN 0 ELSE consecutive_failures + 1 END,
              last_failed_at = CASE WHEN $1 THEN last_failed_at ELSE NOW() END
       WHERE id = $3`,
      [probe.ok, probe.latencyMs, proxyId]
    );

    logger.info(`Manual proxy added (working=${probe.ok})`, {
      host: payload.host,
      port,
      protocol,
    });

    return await this._getById(proxyId);
  }

  /**
   * Delete a proxy. Direct VPS row cannot be removed.
   */
  async deleteProxy(id) {
    const row = await this._getById(id);
    if (!row) throw new AppError('Proxy not found', 404, 'PROXY_NOT_FOUND');
    if (row.metadata && row.metadata.direct) {
      throw new AppError('Cannot delete the VPS-direct proxy entry', 400, 'PROXY_PROTECTED');
    }
    await pool.query('DELETE FROM proxies WHERE id = $1', [id]);
    return { id, deleted: true };
  }

  async _getById(id) {
    const r = await pool.query(
      `SELECT id, host, port, protocol, username, password_enc, secret,
              source, is_working, priority, active_assignments, total_assignments,
              last_checked_at, last_failed_at, last_latency_ms,
              consecutive_failures, metadata, created_at
       FROM proxies WHERE id = $1`,
      [id]
    );
    return r.rows[0] || null;
  }

  // =========================================================================
  // Free proxy scraper
  // =========================================================================

  /**
   * Pull candidate IPs from public lists, dedupe and probe them.
   * Top FREE_PROXY_POOL_SIZE working entries are kept; rest discarded.
   */
  async refreshFreeProxies() {
    if (this._scrapeInFlight) {
      logger.debug('refreshFreeProxies: already in flight');
      return { added: 0, kept: 0, rejected: 0, skipped: true };
    }
    this._scrapeInFlight = true;
    try {
      // Count current working free proxies first.
      const countRes = await pool.query(
        `SELECT COUNT(*)::int AS c FROM proxies WHERE source = 'free' AND is_working = TRUE`
      );
      const currentWorking = countRes.rows[0].c;
      if (currentWorking >= FREE_PROXY_POOL_SIZE) {
        logger.debug(`refreshFreeProxies: pool full (${currentWorking})`);
        return { added: 0, kept: currentWorking, rejected: 0 };
      }

      const need = FREE_PROXY_POOL_SIZE - currentWorking;

      // Fetch candidate lists (parallel, tolerant of failures).
      const lists = await Promise.allSettled(
        FREE_PROXY_SOURCES.map((url) => fetchText(url))
      );

      const candidates = new Map(); // key: host:port:protocol
      for (const settled of lists) {
        if (settled.status !== 'fulfilled') continue;
        for (const line of settled.value.split(/\r?\n/)) {
          const c = parseCandidate(line, 'socks5');
          if (!c) continue;
          const key = `${c.host}:${c.port}:${c.protocol}`;
          if (!candidates.has(key)) candidates.set(key, c);
          if (candidates.size >= MAX_CANDIDATE_BATCH * 5) break;
        }
      }

      const candList = Array.from(candidates.values()).slice(0, MAX_CANDIDATE_BATCH);
      if (candList.length === 0) {
        logger.warn('refreshFreeProxies: no candidates fetched');
        return { added: 0, kept: currentWorking, rejected: 0 };
      }

      logger.info(`Probing ${candList.length} free proxy candidates (need ${need})`);

      let added = 0;
      let rejected = 0;
      const concurrency = 25;
      let cursor = 0;

      const worker = async () => {
        while (added < need && cursor < candList.length) {
          const idx = cursor++;
          const cand = candList[idx];
          // Skip if we already store a row for this host:port:protocol.
          const exists = await pool.query(
            `SELECT id FROM proxies WHERE host=$1 AND port=$2 AND protocol=$3`,
            [cand.host, cand.port, cand.protocol]
          );
          if (exists.rowCount > 0) {
            rejected++;
            continue;
          }
          const probe = await probeWithTimeout(cand).catch(() => ({ ok: false, latencyMs: 0 }));
          if (!probe.ok) {
            rejected++;
            continue;
          }
          await pool.query(
            `INSERT INTO proxies
              (host, port, protocol, source, is_working, priority,
               last_checked_at, last_latency_ms)
             VALUES ($1,$2,$3,'free',TRUE,100,NOW(),$4)
             ON CONFLICT (host, port, protocol) DO NOTHING`,
            [cand.host, cand.port, cand.protocol, probe.latencyMs]
          );
          added++;
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));

      logger.info(`refreshFreeProxies done: added=${added} rejected=${rejected}`);
      return { added, kept: currentWorking + added, rejected };
    } finally {
      this._scrapeInFlight = false;
    }
  }

  /**
   * Re-validate every existing proxy. Free proxies that fail twice in a row
   * are evicted to free capacity for the scraper to refill.
   */
  async revalidateAll() {
    const rows = (await pool.query(
      `SELECT id, host, port, protocol, source, consecutive_failures
       FROM proxies WHERE host <> '__direct__'`
    )).rows;
    if (rows.length === 0) return { checked: 0, evicted: 0 };

    let evicted = 0;
    const concurrency = 15;
    let cursor = 0;
    const worker = async () => {
      while (cursor < rows.length) {
        const r = rows[cursor++];
        const probe = await probeWithTimeout(r).catch(() => ({ ok: false, latencyMs: 0 }));
        if (probe.ok) {
          await pool.query(
            `UPDATE proxies SET is_working=TRUE, last_checked_at=NOW(),
                    last_latency_ms=$1, consecutive_failures=0
             WHERE id=$2`,
            [probe.latencyMs, r.id]
          );
        } else {
          // Free proxies: evict after 2 consecutive failures.
          if (r.source === 'free' && r.consecutive_failures + 1 >= 2) {
            await pool.query('DELETE FROM proxies WHERE id = $1', [r.id]);
            evicted++;
          } else {
            await pool.query(
              `UPDATE proxies SET is_working=FALSE, last_checked_at=NOW(),
                      last_failed_at=NOW(), consecutive_failures=consecutive_failures+1
               WHERE id=$1`,
              [r.id]
            );
          }
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    if (evicted) logger.info(`Proxy revalidation evicted ${evicted} dead free proxies`);
    return { checked: rows.length, evicted };
  }

  // =========================================================================
  // Assignment / rotation
  // =========================================================================

  /**
   * Resolve the proxy currently assigned to a session, if any.
   */
  async getProxyForSession(sessionId) {
    const r = await pool.query(
      `SELECT p.* FROM session_proxy_assignments spa
       JOIN proxies p ON p.id = spa.proxy_id
       WHERE spa.session_id = $1`,
      [sessionId]
    );
    return r.rows[0] || null;
  }

  /**
   * Assign a proxy for the given session, enforcing MAX_SESSIONS_PER_PROXY.
   *
   * Selection order:
   *   1. The session's existing assignment, if still working
   *   2. The VPS-direct row (id of __direct__) until it has 4 assignments
   *   3. Highest-priority working proxy under capacity (manual > free)
   *   4. Otherwise, fall back to direct (the panel still works, just not rotated).
   *
   * @param {number|string} sessionId
   * @returns {Promise<object|null>} proxy row, or null if nothing usable.
   */
  async assignProxyForSession(sessionId) {
    const existing = await this.getProxyForSession(sessionId);
    if (existing && existing.is_working) {
      return existing;
    }

    // Find first proxy with capacity, ordered priority desc.
    const r = await pool.query(
      `SELECT * FROM proxies
       WHERE is_working = TRUE
         AND active_assignments < $1
       ORDER BY priority DESC, last_latency_ms NULLS LAST
       LIMIT 1`,
      [MAX_SESSIONS_PER_PROXY]
    );
    let proxy = r.rows[0];

    if (!proxy) {
      // No capacity anywhere - fall back to direct VPS (overflow allowed).
      const direct = await pool.query(
        `SELECT * FROM proxies WHERE host='__direct__' LIMIT 1`
      );
      proxy = direct.rows[0] || null;
    }
    if (!proxy) return null;

    if (existing && existing.id !== proxy.id) {
      await this.releaseProxy(sessionId);
    }

    await pool.query(
      `INSERT INTO session_proxy_assignments (session_id, proxy_id, assigned_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (session_id) DO UPDATE SET proxy_id = EXCLUDED.proxy_id, assigned_at = NOW()`,
      [sessionId, proxy.id]
    );
    await pool.query(
      `UPDATE proxies SET active_assignments = active_assignments + 1,
              total_assignments = total_assignments + 1 WHERE id = $1`,
      [proxy.id]
    );
    await pool.query(`UPDATE sessions SET proxy_id = $1 WHERE id = $2`, [proxy.id, sessionId]);
    return proxy;
  }

  async releaseProxy(sessionId) {
    const existing = await pool.query(
      `DELETE FROM session_proxy_assignments WHERE session_id = $1 RETURNING proxy_id`,
      [sessionId]
    );
    if (existing.rowCount > 0) {
      await pool.query(
        `UPDATE proxies SET active_assignments = GREATEST(active_assignments - 1, 0)
         WHERE id = $1`,
        [existing.rows[0].proxy_id]
      );
    }
    await pool.query(`UPDATE sessions SET proxy_id = NULL WHERE id = $1`, [sessionId]);
  }

  /**
   * Translate a stored proxy row into the GramJS proxy interface.
   * Returns null when the proxy is the VPS-direct sentinel (no proxy).
   */
  buildGramJSProxy(proxyRow) {
    if (!proxyRow) return null;
    if (proxyRow.host === '__direct__') return null;
    if (proxyRow.metadata && proxyRow.metadata.direct) return null;

    const password = proxyRow.password_enc ? safeDecrypt(proxyRow.password_enc) : undefined;

    if (proxyRow.protocol === 'mtproto') {
      return {
        ip: proxyRow.host,
        port: Number(proxyRow.port),
        secret: proxyRow.secret || '',
        MTProxy: true,
      };
    }

    if (proxyRow.protocol === 'socks5' || proxyRow.protocol === 'socks4') {
      return {
        ip: proxyRow.host,
        port: Number(proxyRow.port),
        socksType: proxyRow.protocol === 'socks4' ? 4 : 5,
        username: proxyRow.username || undefined,
        password: password,
        timeout: 15,
      };
    }

    // HTTP(S) - GramJS doesn't natively support HTTP CONNECT proxies in the
    // MTProto path, so we treat them as best-effort SOCKS5-compatible probes
    // for storage but skip them when building a usable gramjs proxy.
    return null;
  }
}

function safeDecrypt(text) {
  try {
    return decrypt(text);
  } catch (err) {
    logger.warn('Failed to decrypt proxy password', { error: err.message });
    return undefined;
  }
}

module.exports = new ProxyService();
module.exports.constants = {
  FREE_PROXY_POOL_SIZE,
  MAX_SESSIONS_PER_PROXY,
  PROXY_RECHECK_INTERVAL_MS,
};
