/**
 * ProxyProviderService — CRUD + orchestration around the proxy_providers
 * table.
 *
 * Responsibilities:
 *   - List / add / update / delete proxy provider configurations.
 *   - Encrypt/decrypt the sensitive credentials at rest.
 *   - Run health checks via the registered driver and persist the result.
 *   - Provision a sticky proxy identity for a panel-session by calling
 *     the driver and persisting the resulting `proxies` row.
 *   - Rotate / release sticky identities tied to a session.
 *
 * This service is the only thing in the codebase that opens the
 * `proxy_providers` table. Everything else (proxyService, anti-detect,
 * controllers) goes through these methods.
 */

const { pool } = require('../config/database');
const logger = require('../utils/logger');
const { encrypt, decrypt } = require('../utils/crypto');
const { AppError } = require('../utils/errorHandler');
const { getDriver, listVendors, vendorLabel } = require('./proxyProviders');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeDecrypt(text) {
  if (!text) return null;
  try { return decrypt(text); }
  catch (err) {
    logger.warn('proxyProviderService: decrypt failed', { error: err.message });
    return null;
  }
}

function maybeEnc(value) {
  if (value == null || value === '') return null;
  return encrypt(String(value));
}

function decodeProvider(row) {
  if (!row) return null;
  const apiExtraJson = row.api_extra_enc
    ? safeDecrypt(row.api_extra_enc)
    : null;
  let apiExtraDecoded = null;
  if (apiExtraJson) {
    try { apiExtraDecoded = JSON.parse(apiExtraJson); }
    catch (_) { apiExtraDecoded = null; }
  }
  return {
    ...row,
    _decoded: {
      endpoint_username: safeDecrypt(row.endpoint_username_enc),
      endpoint_password: safeDecrypt(row.endpoint_password_enc),
      api_key: safeDecrypt(row.api_key_enc),
      api_extra: apiExtraDecoded,
    },
    _apiExtraDecoded: apiExtraDecoded,
  };
}

function publicShape(row) {
  if (!row) return null;
  // Strip every encrypted column before sending over the wire.
  const out = {
    id: row.id,
    user_id: row.user_id,
    vendor: row.vendor,
    vendor_label: vendorLabel(row.vendor),
    label: row.label,
    enabled: row.enabled,
    endpoint_host: row.endpoint_host,
    endpoint_port: row.endpoint_port,
    endpoint_protocol: row.endpoint_protocol,
    has_endpoint_username: !!row.endpoint_username_enc,
    has_endpoint_password: !!row.endpoint_password_enc,
    has_api_key: !!row.api_key_enc,
    api_extra: row._apiExtraDecoded || null,
    country_code: row.country_code || null,
    sticky_lifetime_minutes: row.sticky_lifetime_minutes,
    rotation_policy: row.rotation_policy,
    rotate_after_uses: row.rotate_after_uses,
    max_sessions_per_ip: row.max_sessions_per_ip,
    last_health_check_at: row.last_health_check_at,
    last_health_ok: row.last_health_ok,
    last_health_message: row.last_health_message,
    last_balance_json: row.last_balance_json,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  return out;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const proxyProviderService = {
  /**
   * @returns {Array<{vendor, label, defaults}>}
   */
  listVendorCatalog() {
    return listVendors();
  },

  async listProviders(userId) {
    const r = await pool.query(
      `SELECT * FROM proxy_providers
        WHERE user_id = $1
        ORDER BY enabled DESC, id ASC`,
      [userId]
    );
    return r.rows.map((row) => publicShape(decodeProvider(row)));
  },

  async getActiveProvider(userId) {
    const r = await pool.query(
      `SELECT * FROM proxy_providers
        WHERE user_id = $1 AND enabled = TRUE
        ORDER BY id ASC
        LIMIT 1`,
      [userId]
    );
    return r.rows[0] ? decodeProvider(r.rows[0]) : null;
  },

  async getProvider(userId, providerId) {
    const r = await pool.query(
      `SELECT * FROM proxy_providers WHERE id = $1 AND user_id = $2`,
      [providerId, userId]
    );
    if (!r.rows[0]) {
      throw new AppError('Proxy provider not found', 404, 'PROVIDER_NOT_FOUND');
    }
    return decodeProvider(r.rows[0]);
  },

  async addProvider(userId, payload) {
    const vendor = String(payload.vendor || '').toLowerCase();
    const driver = getDriver(vendor);
    if (!driver) {
      throw new AppError(
        `Unknown vendor "${vendor}". Pick from: ${listVendors().map((v) => v.vendor).join(', ')}`,
        400, 'PROVIDER_UNKNOWN_VENDOR'
      );
    }
    const defaults = driver.constructor.defaults();
    const host = String(payload.endpoint_host || defaults.gatewayHost || '').trim();
    const port = parseInt(payload.endpoint_port || defaults.gatewayPort || 0, 10);
    const protocol = String(
      payload.endpoint_protocol || defaults.gatewayProtocol || 'http'
    ).toLowerCase();
    if (!host || !port) {
      throw new AppError(
        'Provider requires endpoint_host and endpoint_port',
        400, 'PROVIDER_BAD_ENDPOINT'
      );
    }
    if (!['http', 'https', 'socks5'].includes(protocol)) {
      throw new AppError(
        `Unsupported endpoint protocol "${protocol}"`,
        400, 'PROVIDER_BAD_PROTOCOL'
      );
    }
    const stickyMinutes = clampInt(payload.sticky_lifetime_minutes, 1, 1440, 30);
    const rotationPolicy = String(payload.rotation_policy || 'per_session');
    if (!['per_session', 'per_login', 'per_n_uses', 'time_based', 'per_request']
      .includes(rotationPolicy)) {
      throw new AppError(`Unknown rotation_policy "${rotationPolicy}"`,
        400, 'PROVIDER_BAD_POLICY');
    }
    const rotateAfterUses = clampInt(payload.rotate_after_uses, 0, 100000, 0);
    const maxSessionsPerIp = clampInt(payload.max_sessions_per_ip, 1, 10, 1);
    const apiExtra = payload.api_extra && typeof payload.api_extra === 'object'
      ? payload.api_extra : null;
    const r = await pool.query(
      `INSERT INTO proxy_providers (
         user_id, vendor, label, enabled,
         endpoint_host, endpoint_port, endpoint_protocol,
         endpoint_username_enc, endpoint_password_enc, api_key_enc, api_extra_enc,
         country_code, sticky_lifetime_minutes, rotation_policy,
         rotate_after_uses, max_sessions_per_ip
       ) VALUES (
         $1, $2, $3, COALESCE($4, TRUE),
         $5, $6, $7,
         $8, $9, $10, $11,
         $12, $13, $14,
         $15, $16
       )
       RETURNING *`,
      [
        userId, vendor, payload.label || null,
        payload.enabled === false ? false : true,
        host, port, protocol,
        maybeEnc(payload.endpoint_username),
        maybeEnc(payload.endpoint_password),
        maybeEnc(payload.api_key),
        apiExtra ? maybeEnc(JSON.stringify(apiExtra)) : null,
        payload.country_code ? String(payload.country_code).toLowerCase() : null,
        stickyMinutes, rotationPolicy,
        rotateAfterUses, maxSessionsPerIp,
      ]
    );
    return publicShape(decodeProvider(r.rows[0]));
  },

  async updateProvider(userId, providerId, patch) {
    const fields = [];
    const params = [];
    let p = 1;

    function set(col, val) { fields.push(`${col} = $${p++}`); params.push(val); }

    if (Object.prototype.hasOwnProperty.call(patch, 'label')) set('label', patch.label || null);
    if (Object.prototype.hasOwnProperty.call(patch, 'enabled')) set('enabled', !!patch.enabled);
    if (Object.prototype.hasOwnProperty.call(patch, 'endpoint_host')) set('endpoint_host', String(patch.endpoint_host));
    if (Object.prototype.hasOwnProperty.call(patch, 'endpoint_port')) set('endpoint_port', parseInt(patch.endpoint_port, 10));
    if (Object.prototype.hasOwnProperty.call(patch, 'endpoint_protocol')) set('endpoint_protocol', String(patch.endpoint_protocol).toLowerCase());
    if (Object.prototype.hasOwnProperty.call(patch, 'endpoint_username')) {
      set('endpoint_username_enc', maybeEnc(patch.endpoint_username));
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'endpoint_password')) {
      set('endpoint_password_enc', maybeEnc(patch.endpoint_password));
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'api_key')) {
      set('api_key_enc', maybeEnc(patch.api_key));
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'api_extra')) {
      set('api_extra_enc',
        patch.api_extra ? maybeEnc(JSON.stringify(patch.api_extra)) : null);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'country_code')) {
      set('country_code', patch.country_code ? String(patch.country_code).toLowerCase() : null);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'sticky_lifetime_minutes')) {
      set('sticky_lifetime_minutes', clampInt(patch.sticky_lifetime_minutes, 1, 1440, 30));
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'rotation_policy')) {
      set('rotation_policy', String(patch.rotation_policy));
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'rotate_after_uses')) {
      set('rotate_after_uses', clampInt(patch.rotate_after_uses, 0, 100000, 0));
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'max_sessions_per_ip')) {
      set('max_sessions_per_ip', clampInt(patch.max_sessions_per_ip, 1, 10, 1));
    }
    if (!fields.length) return this.getProvider(userId, providerId).then(publicShape);
    fields.push(`updated_at = NOW()`);
    params.push(providerId, userId);
    const r = await pool.query(
      `UPDATE proxy_providers SET ${fields.join(', ')}
        WHERE id = $${p++} AND user_id = $${p++}
        RETURNING *`,
      params
    );
    if (!r.rows[0]) {
      throw new AppError('Proxy provider not found', 404, 'PROVIDER_NOT_FOUND');
    }
    return publicShape(decodeProvider(r.rows[0]));
  },

  async deleteProvider(userId, providerId) {
    const r = await pool.query(
      `DELETE FROM proxy_providers WHERE id = $1 AND user_id = $2 RETURNING id`,
      [providerId, userId]
    );
    if (!r.rows[0]) {
      throw new AppError('Proxy provider not found', 404, 'PROVIDER_NOT_FOUND');
    }
    return { id: r.rows[0].id };
  },

  /**
   * Fire the driver's validateCredentials() and persist the result on
   * the row. Used by the "Test" button in the Providers UI.
   */
  async testProvider(userId, providerId) {
    const provider = await this.getProvider(userId, providerId);
    const driver = getDriver(provider.vendor);
    if (!driver) {
      throw new AppError(
        `No driver registered for vendor "${provider.vendor}"`,
        500, 'PROVIDER_NO_DRIVER'
      );
    }
    let result;
    try {
      result = await driver.validateCredentials(provider, provider._decoded);
    } catch (err) {
      result = { ok: false, message: err.message };
    }
    const balance = result.balance || null;
    await pool.query(
      `UPDATE proxy_providers
          SET last_health_check_at = NOW(),
              last_health_ok = $1,
              last_health_message = $2,
              last_balance_json = COALESCE($3::jsonb, last_balance_json)
        WHERE id = $4 AND user_id = $5`,
      [
        !!result.ok, result.message || null,
        balance ? JSON.stringify(balance) : null,
        providerId, userId,
      ]
    );
    return { ...result, balance: balance };
  },

  /**
   * Mint a sticky proxy row for one panel-session. Called from
   * proxyService.pickProxyForSession when an enabled provider exists
   * and the session has no live binding.
   *
   * Returns the *raw* `proxies` row (post-INSERT) ready for the caller
   * to bind via session_proxy_assignments. Pass through-arguments allow
   * future drivers to take ctx hints (e.g. preferred country).
   */
  async provisionForSession(provider, ctx = {}) {
    if (!provider) throw new AppError('provider required', 500, 'PROVIDER_REQUIRED');
    const driver = getDriver(provider.vendor);
    if (!driver) {
      throw new AppError(
        `No driver registered for vendor "${provider.vendor}"`,
        500, 'PROVIDER_NO_DRIVER'
      );
    }
    const payload = await driver.provisionForSession(
      provider, provider._decoded || {}, ctx
    );
    return persistProxyRow(provider, payload);
  },

  /**
   * Force-rotate the IP behind an existing provider proxy row.
   * Regenerates the suffix and updates the row in place; returns the
   * fresh row.
   */
  async rotateProxy(provider, proxyRow) {
    if (!provider || !proxyRow) {
      throw new AppError('provider + proxyRow required', 500, 'PROVIDER_BAD_INPUT');
    }
    const driver = getDriver(provider.vendor);
    if (!driver) {
      throw new AppError(
        `No driver registered for vendor "${provider.vendor}"`,
        500, 'PROVIDER_NO_DRIVER'
      );
    }
    const payload = await driver.rotate(provider, provider._decoded || {}, proxyRow);
    return updateProxyRow(provider, proxyRow, payload);
  },

  /** Convenience: same shape as proxyService.safeDecrypt (re-exported). */
  decodeProvider,
  publicShape,
};

// ---------------------------------------------------------------------------
// Internal helpers — talking to the `proxies` table.
// ---------------------------------------------------------------------------

async function persistProxyRow(provider, payload) {
  const passwordEnc = payload.password ? encrypt(String(payload.password)) : null;
  const metadata = payload.metadata || {};
  // Provider-minted rows are always fresh — the gateway host:port is
  // shared, but each row is tagged with a unique (provider_id,
  // sticky_session_token) pair (see migration v22 partial unique index).
  const r = await pool.query(
    `INSERT INTO proxies (
       host, port, protocol, username, password_enc,
       source, is_working, priority,
       active_assignments, total_assignments,
       last_checked_at, metadata,
       user_id, label, country_code,
       last_health_check, last_health_ok,
       provider_id, sticky_session_token, sticky_expires_at,
       provider_use_count
     ) VALUES (
       $1, $2, $3, $4, $5,
       'provider', TRUE, 500,
       0, 0,
       NOW(), $6::jsonb,
       $7, $8, $9,
       NOW(), TRUE,
       $10, $11, $12,
       0
     )
     RETURNING *`,
    [
      payload.host, payload.port, payload.protocol,
      payload.username, passwordEnc,
      JSON.stringify(metadata),
      provider.user_id, payload.label || null,
      payload.country_code || null,
      provider.id, payload.sticky_session_token, payload.sticky_expires_at,
    ]
  );
  return r.rows[0];
}

async function updateProxyRow(provider, proxyRow, payload) {
  const passwordEnc = payload.password ? encrypt(String(payload.password)) : null;
  const r = await pool.query(
    `UPDATE proxies SET
       username = $1,
       password_enc = COALESCE($2, password_enc),
       sticky_session_token = $3,
       sticky_expires_at = $4,
       metadata = $5::jsonb,
       last_checked_at = NOW(),
       last_health_check = NOW(),
       last_health_ok = TRUE,
       is_working = TRUE
     WHERE id = $6
     RETURNING *`,
    [
      payload.username, passwordEnc,
      payload.sticky_session_token, payload.sticky_expires_at,
      JSON.stringify(payload.metadata || {}),
      proxyRow.id,
    ]
  );
  return r.rows[0] || proxyRow;
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

module.exports = proxyProviderService;
