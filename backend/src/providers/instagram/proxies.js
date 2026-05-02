/**
 * Instagram proxy validator (provider.proxies.*).
 *
 * The TG proxy validator pings Telegram DC4. The IG validator hits
 * i.instagram.com using node fetch (or undici via instagram-private-api's
 * own httpClient). The validation result lands in
 *   proxies.validated_for_instagram BOOLEAN
 *   proxies.last_validated_instagram_at TIMESTAMP
 *
 * The CRUD itself is shared with the TG proxyService — this module ONLY
 * overrides `.validate()` so it points at IG. List / create / delete /
 * assign all delegate to the existing service so we don't duplicate the
 * row/audit logic.
 */

const { pool } = require('../../config/database');
const logger = require('../../utils/logger');
const proxyService = require('../../services/proxyService');
const systemSettings = require('../../services/systemSettingsService');

async function list(...args)   { return proxyService.listProxies(...args); }
async function create(...args) { return proxyService.createProxy(...args); }
async function deleteProxy(...args) { return proxyService.deleteProxy(...args); }
async function assign(...args) { return proxyService.assignProxy ? proxyService.assignProxy(...args) : null; }

/**
 * Validate a proxy against Instagram. Independent of TG validation —
 * a proxy can be marked good for one platform and bad for the other.
 */
async function validate({ proxyId, userId }) {
  if (!proxyId) throw new Error('proxyId required');

  const r = await pool.query(
    `SELECT id, host, port, username, password, type, user_id
       FROM proxies WHERE id = $1 AND user_id = $2`,
    [proxyId, userId]
  );
  if (r.rows.length === 0) {
    const e = new Error('Proxy not found');
    e.statusCode = 404;
    throw e;
  }
  const proxy = r.rows[0];

  const endpoint = await systemSettings.getSetting('proxies.instagram.validate_endpoint')
    || 'https://i.instagram.com/api/v1/users/web_profile_info/?username=instagram';

  let ok = false;
  let latencyMs = null;
  let detail = null;

  try {
    // eslint-disable-next-line global-require
    const { IgApiClient } = require('instagram-private-api');
    const client = new IgApiClient();
    client.state.generateDevice(`proxy_validator_${proxy.id}`);
    const proxyUrl =
      `${proxy.type || 'http'}://` +
      (proxy.username ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@` : '') +
      `${proxy.host}:${proxy.port}`;
    client.state.proxyUrl = proxyUrl;

    const start = Date.now();
    // Lightweight unauth call — search for "instagram" lands a quick JSON.
    await client.search.users('instagram');
    latencyMs = Date.now() - start;
    ok = true;
  } catch (err) {
    detail = err.message;
    logger.warn(`IG.proxies.validate proxy=${proxyId}: ${err.message}`);
  }

  await pool.query(
    `UPDATE proxies
        SET validated_for_instagram = $1,
            last_validated_instagram_at = NOW(),
            updated_at = NOW()
      WHERE id = $2`,
    [ok, proxyId]
  );

  return {
    proxyId,
    platform: 'instagram',
    ok,
    latencyMs,
    detail,
    validated_at: new Date().toISOString(),
    endpoint,
  };
}

module.exports = {
  listProxies: list,
  list,
  createProxy: create,
  create,
  deleteProxy,
  delete: deleteProxy,
  assignProxy: assign,
  assign,
  validateProxy: validate,
  validate,
};
