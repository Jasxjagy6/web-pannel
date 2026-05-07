/**
 * IPRoyal driver — first-class default for the auto-rotating proxy system.
 *
 * Sticky-session contract:
 *   username:password_country-XX_session-XXXXXXXX_lifetime-30m
 *      @geo.iproyal.com:12321
 *
 *   - country-XX optional; we omit when the user picks "any".
 *   - session-XXXXXXXX = 8 random hex chars (we generate per panel-session).
 *   - lifetime-Nm tells the gateway how long the same NAT identity is held.
 *
 * Rotating per panel-session: rerun the provision logic with a fresh
 * 8-char token. The gateway routes the connection to a new mobile NAT
 * identity from its pool.
 *
 * Reseller / dashboard API:
 *   GET https://apid.iproyal.com/v1/reseller/info
 *   X-Access-Token: <api_key>
 * Returns balance + active orders. Optional — the rotation works without
 * the api_key, the panel just can't show balance.
 */

const https = require('https');
const ProxyProviderDriver = require('./base');

const RESELLER_BASE_URL = process.env.IPROYAL_RESELLER_URL
  || 'https://apid.iproyal.com/v1/reseller';

class IPRoyalDriver extends ProxyProviderDriver {
  static vendor = 'iproyal';

  static defaults() {
    return {
      gatewayHost: 'geo.iproyal.com',
      gatewayPort: 12321,
      gatewayProtocol: 'http',
      suffixHelp:
        'Sticky session via IPRoyal username suffix: '
        + 'username:password_country-XX_session-XXXXXXXX_lifetime-30m@geo.iproyal.com:12321',
    };
  }

  // -----------------------------------------------------------------
  // Reseller API helpers.
  // -----------------------------------------------------------------

  _resellerRequest(apiKey, urlPath) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, RESELLER_BASE_URL + '/');
      const req = https.request({
        method: 'GET',
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        headers: {
          'X-Access-Token': apiKey,
          'Accept': 'application/json',
          'User-Agent': 'web-pannel/auto-proxy/1',
        },
        timeout: 10_000,
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(body)); }
            catch (err) { reject(new Error(`iproyal: bad JSON (${err.message})`)); }
          } else {
            reject(new Error(
              `iproyal: HTTP ${res.statusCode} — ${body.slice(0, 200)}`
            ));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('iproyal: request timeout')); });
      req.end();
    });
  }

  async validateCredentials(provider, decoded) {
    if (!decoded.api_key) {
      return {
        ok: true,
        message: 'No API key configured; proxy rotation will work but '
          + 'balance / quota will be unavailable.',
      };
    }
    try {
      const info = await this._resellerRequest(decoded.api_key, 'info');
      return {
        ok: true,
        message: 'IPRoyal reseller credentials accepted',
        balance: info,
      };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  async fetchBalance(provider, decoded) {
    if (!decoded.api_key) return null;
    try {
      return await this._resellerRequest(decoded.api_key, 'info');
    } catch (err) {
      return { error: err.message };
    }
  }

  // The default provisionForSession / rotate / release in the base class
  // already implement the IPRoyal contract verbatim, so we don't override.
}

module.exports = IPRoyalDriver;
