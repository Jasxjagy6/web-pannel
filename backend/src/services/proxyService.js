/**
 * ProxyService - Dynamic proxy pool for Telegram MTProto connections.
 *
 * Responsibilities:
 *   - Validate user-owned proxies against Telegram MTProto endpoints
 *   - Persist encrypted credentials and health metadata
 *   - Bind one dedicated proxy to one strict Telegram session
 *
 * Public API:
 *   listMyProxies(userId), addMyProxy(userId, payload),
 *   assignUserProxyToSession(userId, sessionId, proxyId),
 *   getProxyForSession(sessionId), buildGramJSProxy(proxy),
 *   reserveAdHoc(key), releaseAdHoc(key), transferAdHocToSession(key, sessionId)
 */

const { pool } = require('../config/database');
const logger = require('../utils/logger');
const { encrypt, decrypt } = require('../utils/crypto');
const { AppError } = require('../utils/errorHandler');
const net = require('net');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const MAX_SESSIONS_PER_PROXY = 1;
const PROXY_RECHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const PROXY_VALIDATION_TIMEOUT_MS = 8000;
const TELEGRAM_PROBE_HOST = '149.154.167.51'; // Telegram DC4 IPv4
const TELEGRAM_PROBE_PORT = 443;

// BYO Proxy — Phase 2 (BYO_PROXY_PROPOSAL §4.2).
//
// REQUIRE_USER_PROXY=true (default) means a session MUST egress through
// a proxy owned by its user. When no working user proxy exists,
// pickProxyForSession() throws NO_USER_PROXY (HTTP 412) instead of
// silently falling back to either the admin pool or the VPS direct IP.
// Operators can flip this off temporarily during the cutover described
// in §4.4 of the proposal.
const REQUIRE_USER_PROXY = String(
  process.env.REQUIRE_USER_PROXY ?? 'true'
).toLowerCase() === 'true';

// Public IP-discovery endpoint used during testMyProxy() to capture the
// proxy's egress IP + country. Configurable via env so an air-gapped
// install can point at an internal mirror.
const EGRESS_FINGERPRINT_URL =
  process.env.PROXY_EGRESS_FINGERPRINT_URL || 'https://api.ipify.org?format=json';

// Instagram reachability probe (Phase 2 §4.2). 200/401 = good (reachable
// + Instagram speaks back), 403 = DC ban (proxy IP in IG blocklist).
const INSTAGRAM_PROBE_URL =
  process.env.PROXY_IG_PROBE_URL || 'https://i.instagram.com/api/v1/qe/sync/';

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

/**
 * Open a SOCKS5 CONNECT tunnel to (host, port) and return the live
 * net.Socket once the proxy acknowledges the request. Used by the
 * egress-IP fingerprint probe in `testMyProxy()`.
 *
 * @returns {Promise<net.Socket>}
 */
function socks5Connect(proxy, host, port, timeoutMs = PROXY_VALIDATION_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* noop */ }
      reject(err instanceof Error ? err : new Error(String(err || 'socks5 failed')));
    };
    sock.setTimeout(timeoutMs);
    sock.once('timeout', () => fail(new Error('socks5 timeout')));
    sock.once('error', fail);
    sock.connect(proxy.port, proxy.host, () => {
      // SOCKS5 greeting. If the proxy needs creds we send 0x02 too.
      const methods = (proxy.username || proxy.password) ? [0x00, 0x02] : [0x00];
      sock.write(Buffer.from([0x05, methods.length, ...methods]));
      sock.once('data', (greet) => {
        if (greet.length < 2 || greet[0] !== 0x05) {
          return fail(new Error('socks5 bad greet'));
        }
        const method = greet[1];
        const sendConnect = () => {
          // ATYP=3 (DOMAIN) keeps DNS resolution server-side.
          const hostBuf = Buffer.from(host, 'utf8');
          const portBuf = Buffer.alloc(2);
          portBuf.writeUInt16BE(port, 0);
          const req = Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
            hostBuf,
            portBuf,
          ]);
          sock.write(req);
          sock.once('data', (resp) => {
            if (resp.length < 2 || resp[0] !== 0x05 || resp[1] !== 0x00) {
              return fail(new Error(`socks5 connect rep=${resp[1]}`));
            }
            settled = true;
            resolve(sock);
          });
        };
        if (method === 0x02) {
          // Username/password sub-negotiation (RFC 1929).
          const u = Buffer.from(String(proxy.username || ''), 'utf8');
          const p = Buffer.from(String(proxy.password || ''), 'utf8');
          const auth = Buffer.concat([
            Buffer.from([0x01, u.length]), u,
            Buffer.from([p.length]), p,
          ]);
          sock.write(auth);
          sock.once('data', (a) => {
            if (a.length < 2 || a[1] !== 0x00) {
              return fail(new Error('socks5 auth failed'));
            }
            sendConnect();
          });
        } else if (method === 0x00) {
          sendConnect();
        } else {
          fail(new Error(`socks5 unsupported method ${method}`));
        }
      });
    });
  });
}

/**
 * Open an HTTP CONNECT tunnel to (host, port) through an HTTP proxy
 * and return the underlying net.Socket once the 200 response is read.
 *
 * @returns {Promise<net.Socket>}
 */
function httpConnect(proxy, host, port, timeoutMs = PROXY_VALIDATION_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* noop */ }
      reject(err instanceof Error ? err : new Error(String(err || 'http connect failed')));
    };
    sock.setTimeout(timeoutMs);
    sock.once('timeout', () => fail(new Error('http connect timeout')));
    sock.once('error', fail);
    sock.connect(proxy.port, proxy.host, () => {
      let req = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n`;
      if (proxy.username || proxy.password) {
        const token = Buffer.from(
          `${proxy.username || ''}:${proxy.password || ''}`
        ).toString('base64');
        req += `Proxy-Authorization: Basic ${token}\r\n`;
      }
      req += '\r\n';
      sock.write(req);
      let buf = '';
      sock.on('data', function onData(chunk) {
        buf += chunk.toString('utf8');
        if (buf.includes('\r\n\r\n')) {
          sock.removeListener('data', onData);
          const status = buf.split(' ')[1];
          if (status === '200') {
            settled = true;
            resolve(sock);
          } else {
            fail(new Error(`http proxy status=${status}`));
          }
        }
      });
    });
  });
}

/**
 * Issue an HTTPS GET to a URL, tunnelled through `proxy`. Returns
 * `{ status, body }`. Bytes-bounded: at most 64 KiB are kept.
 *
 * Used by the L7 egress fingerprint probe (egress IP / country) and
 * by the Instagram reachability check.
 */
async function httpGetThroughProxy(proxy, urlString, timeoutMs = PROXY_VALIDATION_TIMEOUT_MS) {
  const u = new URL(urlString);
  const host = u.hostname;
  const port = parseInt(u.port || (u.protocol === 'https:' ? '443' : '80'), 10);
  let sock;
  if (proxy.protocol === 'socks5' || proxy.protocol === 'socks4') {
    sock = await socks5Connect(proxy, host, port, timeoutMs);
  } else if (proxy.protocol === 'http' || proxy.protocol === 'https') {
    sock = await httpConnect(proxy, host, port, timeoutMs);
  } else {
    throw new Error(`unsupported protocol ${proxy.protocol} for L7 probe`);
  }
  return new Promise((resolve, reject) => {
    let stream = sock;
    if (u.protocol === 'https:') {
      const tls = require('tls');
      stream = tls.connect({ socket: sock, servername: host });
      stream.on('error', (err) => {
        try { sock.destroy(); } catch { /* noop */ }
        reject(err);
      });
      stream.on('secureConnect', () => writeRequest(stream));
    } else {
      writeRequest(stream);
    }
    function writeRequest(s) {
      const req =
        `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
        `Host: ${host}\r\n` +
        `User-Agent: panel-proxy-validator/1.0\r\n` +
        'Accept: */*\r\n' +
        'Connection: close\r\n\r\n';
      s.write(req);
      let buf = Buffer.alloc(0);
      s.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length > 64 * 1024) buf = buf.slice(0, 64 * 1024);
      });
      const close = () => {
        const text = buf.toString('utf8');
        const headerEnd = text.indexOf('\r\n\r\n');
        const headLine = headerEnd > 0 ? text.slice(0, text.indexOf('\r\n')) : text.slice(0, 64);
        const status = parseInt((headLine.split(' ')[1] || '0'), 10);
        const body = headerEnd > 0 ? text.slice(headerEnd + 4) : '';
        try { s.destroy(); } catch { /* noop */ }
        try { sock.destroy(); } catch { /* noop */ }
        resolve({ status, body });
      };
      s.on('end', close);
      s.on('close', close);
      s.on('error', (err) => {
        try { sock.destroy(); } catch { /* noop */ }
        reject(err);
      });
      s.setTimeout(timeoutMs, () => {
        try { s.destroy(); } catch { /* noop */ }
        reject(new Error('http get timeout'));
      });
    }
  });
}

class ProxyService {
  constructor() {
  }

  // =========================================================================
  // Background scheduling
  // =========================================================================

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
              created_at,
              user_id, label, country_code, notes,
              last_health_check, last_health_ok, health_message
       FROM proxies
       ${where}
       ORDER BY priority DESC, last_latency_ms NULLS LAST, id ASC`,
      params
    );
    return result.rows.map((r) => ({ ...r, hasPassword: !!r.password_enc }));
  }

  // BYO Proxy — Phase 1 (user-scoped view)

  /**
   * List proxies that belong to a specific user. NULL `user_id` rows
   * (the shared admin pool) are deliberately excluded from this view —
   * the user-facing UI must NEVER leak admin-pool entries into a
   * regular user's account.
   *
   * @param {number} userId
   * @returns {Promise<object[]>}
   */
  async listMyProxies(userId) {
    if (!userId) {
      throw new AppError('userId required', 400, 'PROXY_USER_ID_REQUIRED');
    }
    const r = await pool.query(
      `SELECT id, host, port, protocol, username, password_enc, source, enabled,
               label, country_code, notes,
              is_working, priority,
              active_assignments, total_assignments,
              last_checked_at, last_failed_at, last_latency_ms,
              consecutive_failures,
              last_health_check, last_health_ok, health_message,
              validated_for_telegram, validated_for_instagram,
               metadata, created_at,
               (SELECT jsonb_agg(jsonb_build_object(
                  'sessionId', s.id,
                  'phone', s.phone,
                  'status', s.status,
                  'isLoggedIn', s.is_logged_in
                ) ORDER BY s.id)
                  FROM session_proxy_assignments a
                  JOIN sessions s ON s.id = a.session_id
                 WHERE a.proxy_id = proxies.id) AS assigned_sessions
         FROM proxies
        WHERE user_id = $1 AND source = 'user'
        ORDER BY priority DESC, last_latency_ms NULLS LAST, id ASC`,
      [userId]
    );
    return r.rows.map((p) => {
      const { password_enc: passwordEnc, ...safe } = p;
      return { ...safe, hasPassword: !!passwordEnc };
    });
  }

  // ===========================================================================
  // BYO Proxy — Phase 2 (user-scoped CRUD + health probe + binding)
  // ===========================================================================
  // The methods in this block are the public surface every BYO-proxy code
  // path must go through. Each one is ownership-checked so a buggy caller
  // can never leak proxy rows across users.

  /**
   * Fetch a single user-owned proxy by id. Returns `null` (not throws)
   * when the row doesn't exist OR is owned by a different user — that
   * way callers can distinguish "not found" vs "not yours" via a single
   * code path and never leak the existence of someone else's proxy.
   *
   * @param {number} userId
   * @param {number} proxyId
   * @returns {Promise<object|null>}
   */
  async getMyProxy(userId, proxyId) {
    if (!userId) throw new AppError('userId required', 400, 'PROXY_USER_ID_REQUIRED');
    if (!proxyId) return null;
    const r = await pool.query(
      `SELECT id, host, port, protocol, username, password_enc, secret,
               source, user_id, enabled, label, country_code, notes,
              is_working, priority,
              active_assignments, total_assignments,
              last_checked_at, last_failed_at, last_latency_ms,
              consecutive_failures,
              last_health_check, last_health_ok, health_message,
              validated_for_telegram, validated_for_instagram,
              metadata, created_at
         FROM proxies
        WHERE id = $1 AND user_id = $2`,
      [proxyId, userId]
    );
    const row = r.rows[0];
    if (!row) return null;
    return { ...row, hasPassword: !!row.password_enc };
  }

  /**
   * Insert a new user-owned proxy. The row is stamped with
   * `user_id = userId`, `source = 'user'`. The DB enforces:
   *   - same (host, port, protocol) cannot exist twice for the same user
   *     (partial unique index uniq_proxies_user_host_port_protocol).
   *   - different users may own the same (host, port, protocol).
   *
   * Surfaces the duplicate-violation as an `AppError` with code
   * `PROXY_DUPLICATE` (HTTP 409) so the API can return a friendly
   * message without leaking the offending other-user row.
   *
   * @param {number} userId
   * @param {{host:string,port:number,protocol?:string,username?:string,
   *          password?:string,secret?:string,priority?:number,
   *          label?:string,country_code?:string,notes?:string,
   *          metadata?:object}} payload
   */
  async addMyProxy(userId, payload) {
    if (!userId) throw new AppError('userId required', 400, 'PROXY_USER_ID_REQUIRED');
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
    const country = payload.country_code
      ? String(payload.country_code).slice(0, 8).toLowerCase()
      : null;
    const label = payload.label ? String(payload.label).slice(0, 120) : null;
    const notes = payload.notes ? String(payload.notes) : null;

    let inserted;
    try {
      inserted = await pool.query(
        `INSERT INTO proxies
           (user_id, host, port, protocol, username, password_enc, secret,
            source, priority, label, country_code, notes, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'user',$8,$9,$10,$11,$12)
         RETURNING id`,
        [
          userId,
          payload.host,
          port,
          protocol,
          payload.username || null,
          passwordEnc,
          payload.secret || null,
          payload.priority != null ? Number(payload.priority) : 600,
          label,
          country,
          notes,
          payload.metadata ? JSON.stringify(payload.metadata) : null,
        ]
      );
    } catch (err) {
      if (err && err.code === '23505') {
        throw new AppError(
          'You already have a proxy with this host:port:protocol.',
          409,
          'PROXY_DUPLICATE'
        );
      }
      throw err;
    }

    const proxyId = inserted.rows[0].id;
    // Eager probe so the user gets fast feedback. Failures are
    // recorded in last_health_* but do not fail the create call.
    try {
      await this.testMyProxy(userId, proxyId);
    } catch (err) {
      logger.debug(`testMyProxy after add failed for proxy=${proxyId}: ${err.message}`);
    }
    return await this.getMyProxy(userId, proxyId);
  }

  /**
   * Soft-update label / notes / country_code for a user-owned proxy.
   * Returns the refreshed row, or 404 when the row doesn't belong to
   * the caller.
   */
  async updateMyProxy(userId, proxyId, patch) {
    if (!userId) throw new AppError('userId required', 400, 'PROXY_USER_ID_REQUIRED');
    const row = await this.getMyProxy(userId, proxyId);
    if (!row) throw new AppError('Proxy not found', 404, 'PROXY_NOT_FOUND');
    const sets = [];
    const params = [];
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'label')) {
      params.push(patch.label ? String(patch.label).slice(0, 120) : null);
      sets.push(`label = $${params.length}`);
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'notes')) {
      params.push(patch.notes ? String(patch.notes) : null);
      sets.push(`notes = $${params.length}`);
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'country_code')) {
      params.push(patch.country_code
        ? String(patch.country_code).slice(0, 8).toLowerCase()
        : null);
      sets.push(`country_code = $${params.length}`);
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'enabled')) {
      params.push(patch.enabled === true);
      sets.push(`enabled = $${params.length}`);
    }
    if (sets.length === 0) return row;
    params.push(proxyId);
    params.push(userId);
    await pool.query(
      `UPDATE proxies SET ${sets.join(', ')}
        WHERE id = $${params.length - 1} AND user_id = $${params.length}`,
      params
    );
    return await this.getMyProxy(userId, proxyId);
  }

  /**
   * Delete a user-owned proxy. The DELETE is scoped to the caller's
   * user_id, so passing someone else's proxyId returns 404 (we never
   * leak the existence of another user's row).
   *
   * Cascades through session_proxy_assignments via FK ON DELETE
   * CASCADE; sessions.bound_proxy_id is set to NULL by the same FK.
   */
  async deleteMyProxy(userId, proxyId) {
    if (!userId) throw new AppError('userId required', 400, 'PROXY_USER_ID_REQUIRED');
    const assigned = await pool.query(
      `SELECT s.id, s.phone
         FROM session_proxy_assignments a
         JOIN sessions s ON s.id = a.session_id
        WHERE a.proxy_id = $1 AND s.user_id = $2
        LIMIT 1`,
      [proxyId, userId]
    );
    if (assigned.rowCount > 0) {
      throw new AppError(
        `Proxy is assigned to session ${assigned.rows[0].phone || assigned.rows[0].id}. Reassign or delete that session first.`,
        409,
        'PROXY_IN_USE'
      );
    }
    const r = await pool.query(
      `DELETE FROM proxies WHERE id = $1 AND user_id = $2 RETURNING id`,
      [proxyId, userId]
    );
    if (r.rowCount === 0) {
      throw new AppError('Proxy not found', 404, 'PROXY_NOT_FOUND');
    }
    return { id: proxyId, deleted: true };
  }

  /**
   * Run the per-proxy health probe described in BYO_PROXY_PROPOSAL §4.2:
   *
   *   L4 — TCP reachability (`net.connect(host, port)` with 8 s timeout).
   *   L7 — egress fingerprint: tunnel a GET to api.ipify.org, read the
   *        public egress IP, and stash it on `metadata.egress_ip` plus
   *        `metadata.egress_country` (when ipinfo is available).
   *   MTProto — open a SOCKS5/HTTP CONNECT tunnel to Telegram DC4 and
   *        confirm the proxy speaks. Sets `validated_for_telegram`.
   *   Instagram — GET https://i.instagram.com/api/v1/qe/sync/ via the
   *        proxy. 200/401 = good, 403 = DC ban (we record the reason).
   *        Sets `validated_for_instagram`.
   *
   * Each step is best-effort and never throws — failures land in
   * `last_health_message`. The aggregate `is_working` boolean reflects
   * "the proxy reached at least L4 + one of {MTProto, IG}" — that's
   * enough for the panel to consider it usable.
   *
   * @param {number} userId
   * @param {number} proxyId
   * @returns {Promise<object>} the updated proxy row
   */
  async testMyProxy(userId, proxyId) {
    if (!userId) throw new AppError('userId required', 400, 'PROXY_USER_ID_REQUIRED');
    const proxy = await this.getMyProxy(userId, proxyId);
    if (!proxy) throw new AppError('Proxy not found', 404, 'PROXY_NOT_FOUND');

    const probeProxy = {
      host: proxy.host,
      port: Number(proxy.port),
      protocol: proxy.protocol,
      username: proxy.username || null,
      password: proxy.password_enc ? safeDecrypt(proxy.password_enc) : null,
    };

    const startedAt = Date.now();
    const messages = [];

    // ----- L4 -----
    let l4 = false;
    let l4Latency = null;
    try {
      const t0 = Date.now();
      const sock = new net.Socket();
      await new Promise((resolve, reject) => {
        sock.setTimeout(PROXY_VALIDATION_TIMEOUT_MS);
        sock.once('timeout', () => { try { sock.destroy(); } catch { /* noop */ } reject(new Error('l4 timeout')); });
        sock.once('error', (err) => { try { sock.destroy(); } catch { /* noop */ } reject(err); });
        sock.connect(probeProxy.port, probeProxy.host, () => {
          l4Latency = Date.now() - t0;
          try { sock.destroy(); } catch { /* noop */ }
          resolve();
        });
      });
      l4 = true;
    } catch (err) {
      messages.push(`l4=${err.message}`);
    }

    // ----- L7 egress fingerprint -----
    let egressIp = proxy.metadata?.egress_ip || null;
    let egressCountry = proxy.metadata?.egress_country || null;
    if (l4 && (probeProxy.protocol === 'socks5' || probeProxy.protocol === 'socks4'
        || probeProxy.protocol === 'http' || probeProxy.protocol === 'https')) {
      try {
        const r = await httpGetThroughProxy(probeProxy, EGRESS_FINGERPRINT_URL);
        if (r.status === 200) {
          try {
            const parsed = JSON.parse(r.body);
            egressIp = parsed.ip || parsed.address || egressIp;
          } catch {
            const m = r.body.match(/\d{1,3}(?:\.\d{1,3}){3}/);
            if (m) egressIp = m[0];
          }
        } else {
          messages.push(`egress=status_${r.status}`);
        }
      } catch (err) {
        messages.push(`egress=${err.message}`);
      }
    }

    // ----- MTProto / Telegram DC4 -----
    let validatedTg = false;
    if (l4 && (probeProxy.protocol === 'socks5' || probeProxy.protocol === 'socks4'
        || probeProxy.protocol === 'http' || probeProxy.protocol === 'https')) {
      try {
        const tunnel = await (
          probeProxy.protocol === 'http' || probeProxy.protocol === 'https'
            ? httpConnect(probeProxy, TELEGRAM_PROBE_HOST, TELEGRAM_PROBE_PORT)
            : socks5Connect(probeProxy, TELEGRAM_PROBE_HOST, TELEGRAM_PROBE_PORT)
        );
        validatedTg = true;
        try { tunnel.destroy(); } catch { /* noop */ }
      } catch (err) {
        messages.push(`tg=${err.message}`);
      }
    } else if (probeProxy.protocol === 'mtproto') {
      // MTProto proxies are TCP-reachable and Telegram-specific by
      // construction. L4 success is sufficient.
      validatedTg = l4;
    }

    // ----- Instagram reachability -----
    let validatedIg = false;
    let igStatus = null;
    if (l4 && (probeProxy.protocol === 'socks5' || probeProxy.protocol === 'socks4'
        || probeProxy.protocol === 'http' || probeProxy.protocol === 'https')) {
      try {
        const r = await httpGetThroughProxy(probeProxy, INSTAGRAM_PROBE_URL);
        igStatus = r.status;
        // 200 / 401 = reachable, 403 = DC ban.
        validatedIg = r.status === 200 || r.status === 401;
        if (r.status === 403) messages.push('ig=dc_banned');
        else if (!validatedIg) messages.push(`ig=status_${r.status}`);
      } catch (err) {
        messages.push(`ig=${err.message}`);
      }
    }

    const ok = l4 && (validatedTg || validatedIg);
    const message = messages.length ? messages.join(' | ') : 'ok';
    const elapsedMs = Date.now() - startedAt;

    const newMeta = {
      ...(proxy.metadata || {}),
      egress_ip: egressIp,
      egress_country: egressCountry,
      ig_status: igStatus,
      last_probe_ms: elapsedMs,
    };

    await pool.query(
      `UPDATE proxies
          SET is_working = $1,
              last_checked_at = NOW(),
              last_health_check = NOW(),
              last_health_ok = $1,
              health_message = $2,
              last_latency_ms = COALESCE($3, last_latency_ms),
              last_failed_at = CASE WHEN $1 THEN last_failed_at ELSE NOW() END,
              consecutive_failures = CASE WHEN $1 THEN 0 ELSE consecutive_failures + 1 END,
              validated_for_telegram = $4,
              last_validated_telegram_at = CASE WHEN $4 THEN NOW() ELSE last_validated_telegram_at END,
              validated_for_instagram = $5,
              last_validated_instagram_at = CASE WHEN $5 THEN NOW() ELSE last_validated_instagram_at END,
              metadata = $6::jsonb
        WHERE id = $7 AND user_id = $8`,
      [
        ok,
        message,
        l4Latency,
        validatedTg,
        validatedIg,
        JSON.stringify(newMeta),
        proxyId,
        userId,
      ]
    );
    return await this.getMyProxy(userId, proxyId);
  }

  /**
   * Mark a user proxy as validated for a single platform without
   * running the full probe. Used by `sessionService.loginSession()`
   * after a real client successfully connects, so a paid proxy gets
   * its TG validation badge straight away.
   */
  async validateMyProxyForPlatform(userId, proxyId, platform) {
    if (!userId) throw new AppError('userId required', 400, 'PROXY_USER_ID_REQUIRED');
    if (!['telegram', 'instagram'].includes(platform)) {
      throw new AppError('platform must be telegram or instagram', 400, 'PROXY_BAD_PLATFORM');
    }
    const col = platform === 'telegram' ? 'validated_for_telegram' : 'validated_for_instagram';
    const stamp = platform === 'telegram'
      ? 'last_validated_telegram_at'
      : 'last_validated_instagram_at';
    const r = await pool.query(
      `UPDATE proxies
          SET ${col} = TRUE, ${stamp} = NOW()
        WHERE id = $1 AND user_id = $2 RETURNING id`,
      [proxyId, userId]
    );
    if (r.rowCount === 0) {
      throw new AppError('Proxy not found', 404, 'PROXY_NOT_FOUND');
    }
    return await this.getMyProxy(userId, proxyId);
  }

  /**
   * Bind a user-owned proxy to a session in one atomic step:
   *   - Insert/upsert into session_proxy_assignments (the trigger will
   *     reject the row if proxy.user_id ≠ session.user_id).
   *   - Mirror the binding into sessions.bound_proxy_id and
   *     sessions.proxy_url so the IG provider's per-row reads stay
   *     authoritative.
   *   - Bump proxies.active_assignments / total_assignments.
   *
   * Returns the freshly bound proxy row.
   */
  async assignUserProxyToSession(userId, sessionId, proxyId, opts = {}) {
    if (!userId) throw new AppError('userId required', 400, 'PROXY_USER_ID_REQUIRED');
    if (!sessionId) throw new AppError('sessionId required', 400, 'SESSION_ID_REQUIRED');
    if (!proxyId) throw new AppError('proxyId required', 400, 'PROXY_ID_REQUIRED');

    // Verify session ownership; the trigger does its own check, but we
    // want a friendly 404 (not 500) when the caller passes a foreign id.
    const s = await pool.query(
      `SELECT id, user_id FROM sessions WHERE id = $1`, [sessionId]
    );
    if (s.rowCount === 0 || s.rows[0].user_id !== userId) {
      throw new AppError('Session not found', 404, 'SESSION_NOT_FOUND');
    }

    const proxy = await this.getMyProxy(userId, proxyId);
    if (!proxy) throw new AppError('Proxy not found', 404, 'PROXY_NOT_FOUND');
    if (opts.requireHealthy && (
      proxy.enabled !== true || proxy.is_working !== true || proxy.validated_for_telegram !== true
    )) {
      throw new AppError('Proxy is disabled or has not passed the Telegram health check', 412, 'PROXY_UNHEALTHY');
    }

    // Build the proxy_url IG reads.
    const proxyUrl = buildProxyUrl(proxy);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM proxies WHERE id = $1 FOR UPDATE', [proxyId]);
      if (opts.dedicated) {
        const used = await client.query(
          `SELECT session_id FROM session_proxy_assignments
            WHERE proxy_id = $1 AND session_id <> $2
            LIMIT 1`,
          [proxyId, sessionId]
        );
        if (used.rowCount > 0) {
          throw new AppError('Proxy is already dedicated to another session', 409, 'PROXY_ALREADY_ASSIGNED');
        }
      }
      // Release any previous binding so active_assignments stays sane.
      const prev = await client.query(
        `DELETE FROM session_proxy_assignments WHERE session_id = $1 RETURNING proxy_id`,
        [sessionId]
      );
      if (prev.rowCount > 0 && prev.rows[0].proxy_id !== proxyId) {
        await client.query(
          `UPDATE proxies SET active_assignments = GREATEST(active_assignments - 1, 0)
            WHERE id = $1`,
          [prev.rows[0].proxy_id]
        );
      }
      await client.query(
        `INSERT INTO session_proxy_assignments (session_id, proxy_id, assigned_at, dedicated)
         VALUES ($1, $2, NOW(), $3)
         ON CONFLICT (session_id) DO UPDATE
           SET proxy_id = EXCLUDED.proxy_id,
               assigned_at = NOW(),
               dedicated = EXCLUDED.dedicated`,
        [sessionId, proxyId, opts.dedicated === true]
      );
      if (prev.rowCount === 0 || prev.rows[0].proxy_id !== proxyId) {
        await client.query(
          `UPDATE proxies SET active_assignments = active_assignments + 1,
                  total_assignments = total_assignments + 1
            WHERE id = $1`,
          [proxyId]
        );
      }
      await client.query(
        `UPDATE sessions
            SET bound_proxy_id = $1,
                proxy_url = $2
          WHERE id = $3`,
        [proxyId, proxyUrl, sessionId]
      );
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }
    logger.info(`Bound user proxy`, { userId, sessionId, proxyId });
    // A TelegramClient keeps its connection transport for life. Rebinding the
    // database row is not enough; evict any live client so the next operation
    // rebuilds it through the newly assigned proxy.
    try {
      const telegramService = require('./telegramService');
      await telegramService.disconnectSession(String(sessionId)).catch(() => {});
    } catch { /* optional during boot/tests */ }
    return await this.getMyProxy(userId, proxyId);
  }

  /**
   * Pick the proxy the panel should use for a session, in priority
   * order:
   *   1. The session's already-bound proxy if it's still working +
   *      under capacity.
   *   2. The user's highest-priority working proxy.
   *
   * When no working user proxy exists AND `REQUIRE_USER_PROXY=true`
   * (default) — the only safe behaviour — throws `NO_USER_PROXY`
   * (HTTP 412). With the env flag flipped off, returns `null` so
   * legacy callers can fall back to the admin pool. Admins bypass
   * the gate entirely.
   *
   * @param {number} userId  - Resolved session owner (NOT the caller).
   * @param {number} sessionId
   * @param {{role?:string}} [opts]  - When `role==='admin'` the gate
   *   is bypassed (mirrors the entitlement gate's admin escape).
   * @returns {Promise<object|null>}
   */
  async pickProxyForSession(userId, sessionId, opts = {}) {
    if (!userId) throw new AppError('userId required', 400, 'PROXY_USER_ID_REQUIRED');
    const role = opts.role || null;

    // Global proxy switch — when OFF return null so the caller falls
    // through to direct VPS egress without the NO_USER_PROXY gate
    // tripping. Existing call sites already treat null as "no proxy".
    const settingsService = require('./systemSettingsService');
    if (!(await settingsService.isProxyGloballyEnabled())) return null;

    // 1. Existing binding still good (and not an expired sticky)?
    if (sessionId) {
      const existing = await pool.query(
        `SELECT p.* FROM proxies p
           JOIN session_proxy_assignments a ON a.proxy_id = p.id
          WHERE a.session_id = $1
            AND p.is_working = TRUE
            AND p.active_assignments <= $2
            AND (p.user_id IS NULL OR p.user_id = $3)
            AND (
              p.sticky_expires_at IS NULL
              OR p.sticky_expires_at > NOW()
            )
          LIMIT 1`,
        [sessionId, MAX_SESSIONS_PER_PROXY, userId]
      );
      if (existing.rows[0]) return existing.rows[0];
    }

    // 2. Highest-priority working user proxy.
    const r = await pool.query(
      `SELECT * FROM proxies
        WHERE user_id = $1
          AND is_working = TRUE
          AND active_assignments < $2
        ORDER BY priority DESC, last_latency_ms NULLS LAST, id ASC
        LIMIT 1`,
      [userId, MAX_SESSIONS_PER_PROXY]
    );
    if (r.rows[0]) return r.rows[0];

    if (role === 'admin') {
      // Admins are allowed to fall through to the legacy admin pool —
      // see the entitlement gate for the same escape hatch.
      return null;
    }
    if (REQUIRE_USER_PROXY) {
      throw new AppError(
        'No working proxy bound to your account. Add one in /proxies.',
        412,
        'NO_USER_PROXY'
      );
    }
    return null;
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
   * Bind the session to the `__direct__` sentinel row and release any
   * non-direct binding it might have. Used when the global proxy
   * toggle is OFF — buildGramJSProxy() turns the direct row into
   * `null` so GramJS connects from the VPS IP.
   */
  async _bindDirectRow(sessionId) {
    const direct = (await pool.query(
      `SELECT * FROM proxies WHERE host='__direct__' LIMIT 1`
    )).rows[0] || null;
    if (!direct) {
      logger.warn(
        `_bindDirectRow(${sessionId}): __direct__ proxy row missing — ` +
          `migration v2 has not run? Returning null so GramJS uses VPS IP.`
      );
      // Best-effort cleanup so a stale binding to a dead proxy doesn't
      // poison the next reconnect.
      if (sessionId) await this.releaseProxy(sessionId).catch(() => {});
      return null;
    }
    if (!sessionId) return direct;
    const existing = await this.getProxyForSession(sessionId);
    if (existing && existing.id === direct.id) return direct;
    if (existing) await this.releaseProxy(sessionId);
    await pool.query(
      `INSERT INTO session_proxy_assignments (session_id, proxy_id, assigned_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (session_id) DO UPDATE
         SET proxy_id = EXCLUDED.proxy_id, assigned_at = NOW()`,
      [sessionId, direct.id]
    );
    try {
      await pool.query(
        `UPDATE sessions
            SET bound_proxy_id = $1,
                proxy_url = NULL
          WHERE id = $2 AND COALESCE(bound_proxy_id, 0) <> $1`,
        [direct.id, sessionId]
      );
    } catch (_) {
      // Column may not exist on very early migration states — ignore.
    }
    return direct;
  }

  /**
   * Assign a proxy for the given session, enforcing MAX_SESSIONS_PER_PROXY.
   *
   * Selection order:
   *   1. The session's existing assignment, if still working
   *   2. BYO Proxy (Phase 2): the session owner's highest-priority
   *      working proxy. When `REQUIRE_USER_PROXY=true` and no working
   *      user proxy exists this throws NO_USER_PROXY (HTTP 412).
   *   3. (legacy) Highest-priority working admin-pool proxy under capacity.
   *   4. (legacy) VPS-direct row, unless STRICT_PROXY_ISOLATION refuses it.
   *
   * @param {number|string} sessionId
   * @returns {Promise<object|null>} proxy row, or null if nothing usable.
   */
  async assignProxyForSession(sessionId) {
    // Global proxy switch (system_settings.proxy.global_enabled).
    // When OFF the panel skips every proxy path (user, admin pool,
    // free pool, auto-rotating providers) and pins the session to the
    // `__direct__` sentinel row so buildGramJSProxy() returns null and
    // GramJS connects from the VPS IP. STRICT_PROXY_ISOLATION /
    // REQUIRE_USER_PROXY do not apply when proxying is globally
    // disabled — the operator has explicitly opted into direct egress.
    const settingsService = require('./systemSettingsService');
    const proxyEnabled = await settingsService.isProxyGloballyEnabled();
    if (!proxyEnabled) {
      return await this._bindDirectRow(sessionId);
    }

    const existing = await this.getProxyForSession(sessionId);
    if (existing && existing.is_working) {
      return existing;
    }

    // Anti-revoke Phase 1 (B3): when STRICT_PROXY_ISOLATION is on,
    // refuse to assign the `__direct__` row (panel-host hosting-ASN IP)
    // for non-trivial accounts.
    const cfg = require('../config/telegram');
    const strictIsolation = !!cfg.STRICT_PROXY_ISOLATION;

    // BYO Proxy — Phase 2: prefer a working proxy owned by this
    // session's user. The pickProxyForSession() helper enforces
    // REQUIRE_USER_PROXY for non-admin owners; admins fall through to
    // the legacy pool.
    let proxy = null;
    let ownerRow = null;
    try {
      ownerRow = (await pool.query(
        `SELECT s.user_id, u.role
           FROM sessions s
           LEFT JOIN users u ON u.id = s.user_id
          WHERE s.id = $1`,
        [sessionId]
      )).rows[0] || null;
    } catch (err) {
      logger.debug(`assignProxyForSession could not load owner ${sessionId}: ${err.message}`);
    }
    if (ownerRow && ownerRow.user_id) {
      try {
        proxy = await this.pickProxyForSession(
          ownerRow.user_id,
          sessionId,
          { role: ownerRow.role || null }
        );
      } catch (err) {
        // NO_USER_PROXY surfaces directly to the caller (e.g.
        // sessionService.loginSession) which logs and keeps the
        // session in `error` state until the user adds a proxy.
        if (err && err.code === 'NO_USER_PROXY') throw err;
        logger.debug(`pickProxyForSession failed ${sessionId}: ${err.message}`);
      }
    }

    if (!proxy) {
      // Admin / legacy fallback path: any working admin-pool proxy
      // under capacity. Skipped when REQUIRE_USER_PROXY=true blocked
      // the user picker above (we'd already have thrown).
      const r = await pool.query(
        `SELECT * FROM proxies
         WHERE is_working = TRUE
           AND active_assignments < $1
           AND host <> '__direct__'
           AND user_id IS NULL
         ORDER BY priority DESC, last_latency_ms NULLS LAST
         LIMIT 1`,
        [MAX_SESSIONS_PER_PROXY]
      );
      proxy = r.rows[0] || null;
    }

    if (!proxy) {
      if (strictIsolation) {
        // Phase 1 — refuse the direct row, return null. Caller
        // (sessionService.loginSession etc.) handles the fallout by
        // logging a warning + keeping the session in `error` state
        // until a proxy comes back.
        logger.warn(
          `assignProxyForSession(${sessionId}): no working proxy with capacity ` +
            `(STRICT_PROXY_ISOLATION=true). Refusing direct VPS egress.`
        );
        return null;
      }
      // Legacy mode (STRICT_PROXY_ISOLATION=false): fall back to
      // direct VPS so the panel still works in single-tenant dev.
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
    // Best-effort: keep sessions.bound_proxy_id in sync so the
    // Anti-Detect dashboard can show the binding without joining.
    // sessions.proxy_id (legacy denormalized hint) is intentionally NOT
    // updated from this connection — callers like loginSession hold a
    // SELECT ... FOR UPDATE on the row in their own transaction and a
    // cross-connection UPDATE would deadlock-wait.
    try {
      const proxyUrl = buildProxyUrl(proxy);
      await pool.query(
        `UPDATE sessions
            SET bound_proxy_id = $1,
                proxy_url = COALESCE($2, proxy_url)
          WHERE id = $3 AND COALESCE(bound_proxy_id, 0) <> $1`,
        [proxy.id, proxyUrl, sessionId]
      );
    } catch (_) {
      // ignore — column may not exist yet on the very first migration apply.
    }
    return proxy;
  }

  /**
   * Reserve a proxy slot for a flow that doesn't have a session row yet
   * (the create-session SendCode step). Bumps the active_assignments
   * counter and remembers the reservation in an in-memory map keyed by
   * `key`. Caller must call `releaseAdHoc(key)` or
   * `transferAdHocToSession(key, sessionId)` to clean up.
   *
   * @param {string} key - Unique caller-supplied key (e.g. `creation:<tempId>`).
   * @param {{userId?:number, proxyId?:number, role?:string}} [opts]
   *   When `userId` is set we prefer a proxy owned by that user (BYO
   *   Proxy, Phase 2). When `proxyId` is also set we pin to that
   *   specific row, after verifying ownership. `role==='admin'` lets
   *   admins fall through to the legacy admin pool.
   * @returns {Promise<object|null>} proxy row or null when nothing is
   *   available. Caller should respect STRICT_PROXY_ISOLATION at the
   *   call site.
   */
  async reserveAdHoc(key, opts = {}) {
    if (!key) throw new Error('reserveAdHoc: key required');
    if (this._adHocReservations && this._adHocReservations.has(key)) {
      // Idempotent — return the same proxy row.
      const existingId = this._adHocReservations.get(key);
      const r = await pool.query(`SELECT * FROM proxies WHERE id = $1`, [existingId]);
      return r.rows[0] || null;
    }

    const userId = opts.userId || null;
    const role = opts.role || null;
    let proxy = null;

    // Strict session creation path: user-owned, Telegram-validated, enabled,
    // one reservation/assignment per proxy, and absolutely no provider/admin/
    // direct fallback.
    if (opts.dedicated === true) {
      if (!userId) throw new AppError('userId required for a dedicated proxy', 400, 'PROXY_USER_ID_REQUIRED');
      if (opts.proxyId) {
        proxy = (await pool.query(
          `UPDATE proxies
              SET active_assignments = 1,
                  total_assignments = total_assignments + 1
            WHERE id = $1 AND user_id = $2 AND source = 'user'
              AND enabled = TRUE AND is_working = TRUE
              AND validated_for_telegram = TRUE
              AND protocol IN ('socks5', 'mtproto')
              AND active_assignments = 0
              AND NOT EXISTS (
                SELECT 1 FROM session_proxy_assignments a WHERE a.proxy_id = proxies.id
              )
          RETURNING *`,
          [opts.proxyId, userId]
        )).rows[0] || null;
      } else {
        proxy = (await pool.query(
          `WITH candidate AS (
             SELECT p.id
               FROM proxies p
              WHERE p.user_id = $1 AND p.source = 'user' AND p.enabled = TRUE
                AND p.is_working = TRUE AND p.validated_for_telegram = TRUE
                AND p.protocol IN ('socks5', 'mtproto')
                AND p.active_assignments = 0
                AND NOT EXISTS (
                  SELECT 1 FROM session_proxy_assignments a WHERE a.proxy_id = p.id
                )
              ORDER BY p.last_latency_ms NULLS LAST, p.id
              FOR UPDATE SKIP LOCKED
              LIMIT 1
           )
           UPDATE proxies p
              SET active_assignments = 1,
                  total_assignments = total_assignments + 1
             FROM candidate c
            WHERE p.id = c.id
        RETURNING p.*`,
          [userId]
        )).rows[0] || null;
      }
      if (!proxy) {
        throw new AppError('No healthy unassigned dedicated proxy is available', 412, 'NO_USER_PROXY');
      }
      if (!this._adHocReservations) this._adHocReservations = new Map();
      this._adHocReservations.set(key, proxy.id);
      return proxy;
    }

    // Legacy-only global bypass. Strict creation returns above and can never
    // reach the direct sentinel, even if an old setting remains in the DB.
    const settingsService = require('./systemSettingsService');
    if (!(await settingsService.isProxyGloballyEnabled())) {
      const direct = (await pool.query(
        `SELECT * FROM proxies WHERE host='__direct__' LIMIT 1`
      )).rows[0] || null;
      if (direct) {
        if (!this._adHocReservations) this._adHocReservations = new Map();
        this._adHocReservations.set(key, direct.id);
      }
      return direct;
    }

    // (a) Caller pinned a specific proxy — must own it (admin
    //     bypasses).
    if (opts.proxyId && userId) {
      const pin = role === 'admin'
        ? (await pool.query(`SELECT * FROM proxies WHERE id = $1 AND is_working = TRUE`, [opts.proxyId])).rows[0]
        : await this.getMyProxy(userId, opts.proxyId);
      if (!pin || (typeof pin.is_working === 'boolean' && !pin.is_working)) {
        throw new AppError('Pinned proxy is not usable', 412, 'PROXY_PIN_UNAVAILABLE');
      }
      proxy = pin;
    }

    // (b) BYO Proxy: pick the user's highest-priority working row.
    if (!proxy && userId) {
      try {
        proxy = await this.pickProxyForSession(userId, null, { role });
      } catch (err) {
        if (err && err.code === 'NO_USER_PROXY') throw err;
        logger.debug(`reserveAdHoc pickProxyForSession failed: ${err.message}`);
      }
    }

    // (c) Admin / legacy: any working pool entry.
    if (!proxy) {
      const r = await pool.query(
        `SELECT * FROM proxies
         WHERE is_working = TRUE
           AND active_assignments < $1
           AND host <> '__direct__'
           AND user_id IS NULL
         ORDER BY priority DESC, last_latency_ms NULLS LAST
         LIMIT 1`,
        [MAX_SESSIONS_PER_PROXY]
      );
      proxy = r.rows[0] || null;
    }

    if (!proxy) {
      // Fall back to the direct row so the caller still sees a non-null
      // value; the buildGramJSProxy() layer will turn it into "no proxy"
      // (i.e. direct connection).
      const d = await pool.query(`SELECT * FROM proxies WHERE host='__direct__' LIMIT 1`);
      proxy = d.rows[0] || null;
    }
    if (!proxy) return null;
    await pool.query(
      `UPDATE proxies SET active_assignments = active_assignments + 1,
              total_assignments = total_assignments + 1 WHERE id = $1`,
      [proxy.id]
    );
    if (!this._adHocReservations) this._adHocReservations = new Map();
    this._adHocReservations.set(key, proxy.id);
    return proxy;
  }

  /**
   * Release an ad-hoc reservation made by `reserveAdHoc(key)`.
   */
  async releaseAdHoc(key) {
    if (!this._adHocReservations) return;
    const proxyId = this._adHocReservations.get(key);
    if (!proxyId) return;
    this._adHocReservations.delete(key);
    await pool.query(
      `UPDATE proxies SET active_assignments = GREATEST(active_assignments - 1, 0)
       WHERE id = $1`,
      [proxyId]
    );
  }

  /**
   * Transfer an ad-hoc reservation into a real session_proxy_assignments
   * row once the session has been persisted. The active_assignments
   * counter stays the same — we just rebrand the slot.
   */
  async transferAdHocToSession(key, sessionId) {
    if (!this._adHocReservations) this._adHocReservations = new Map();
    const proxyId = this._adHocReservations.get(key);
    if (!proxyId) {
      // No reservation — fall back to a fresh allocation.
      return await this.assignProxyForSession(sessionId);
    }
    this._adHocReservations.delete(key);
    await pool.query(
      `INSERT INTO session_proxy_assignments (session_id, proxy_id, assigned_at, dedicated)
       VALUES ($1, $2, NOW(), TRUE)
       ON CONFLICT (session_id) DO UPDATE
         SET proxy_id = EXCLUDED.proxy_id,
             assigned_at = NOW(),
             dedicated = TRUE`,
      [sessionId, proxyId]
    );
    const proxy = (await pool.query(`SELECT * FROM proxies WHERE id = $1`, [proxyId])).rows[0] || null;
    if (proxy) {
      await pool.query(
        `UPDATE sessions SET bound_proxy_id = $1, proxy_url = $2, updated_at = NOW()
          WHERE id = $3`,
        [proxyId, buildProxyUrl(proxy), sessionId]
      );
    }
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
    // sessions.proxy_id is a denormalized hint; the caller updates it under
    // its own transaction. Avoid lock contention from a separate connection.
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

/**
 * Build a `protocol://[user[:pass]@]host:port` URL string for a proxy
 * row. Used to mirror a binding into `sessions.proxy_url` so the IG
 * provider's per-row reads (`SELECT proxy_url ...`) keep working
 * without an extra join.
 */
function buildProxyUrl(proxy) {
  if (!proxy || !proxy.host || !proxy.port) return null;
  if (proxy.host === '__direct__') return null;
  if (proxy.metadata && proxy.metadata.direct) return null;
  const proto = proxy.protocol || 'socks5';
  if (proto === 'mtproto') {
    // Telegram's MTProto proxy URL form.
    return `https://t.me/proxy?server=${encodeURIComponent(proxy.host)}` +
      `&port=${proxy.port}&secret=${encodeURIComponent(proxy.secret || '')}`;
  }
  const user = proxy.username
    ? `${encodeURIComponent(proxy.username)}` +
      (proxy.password_enc
        ? `:${encodeURIComponent(safeDecrypt(proxy.password_enc) || '')}`
        : '')
    : '';
  const auth = user ? `${user}@` : '';
  return `${proto}://${auth}${proxy.host}:${proxy.port}`;
}

module.exports = new ProxyService();
module.exports.constants = {
  MAX_SESSIONS_PER_PROXY,
  PROXY_RECHECK_INTERVAL_MS,
  REQUIRE_USER_PROXY,
};
module.exports.buildProxyUrl = buildProxyUrl;
