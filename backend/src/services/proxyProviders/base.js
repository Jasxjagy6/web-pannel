/**
 * Base class for rotating-proxy provider drivers.
 *
 * Every driver implements four operations against an upstream rotating
 * proxy provider (IPRoyal / SOAX / ProxyEmpire / Smartproxy / custom):
 *
 *   - validateCredentials(provider)
 *       Sanity-check the configured gateway + creds. Returns
 *       { ok, message, balance? }. Used by the "Test" button in the
 *       Providers UI and by the periodic health check.
 *
 *   - fetchBalance(provider)
 *       Optional. If the vendor exposes a dashboard / reseller API the
 *       driver can return a JSON snapshot of remaining balance / quota.
 *       Returned verbatim; the UI just renders the most useful fields.
 *
 *   - provisionForSession(provider, { sessionId, role, country })
 *       Mint a sticky proxy identity for one panel-session. The driver
 *       composes a unique username suffix that the upstream gateway
 *       uses to route to a specific NAT identity from its IP pool, and
 *       returns a row-shaped payload: { host, port, protocol, username,
 *       password, sticky_session_token, sticky_expires_at, country_code,
 *       label, metadata }.
 *
 *   - rotate(provider, proxyRow)
 *       Force a new IP for an already-minted proxy. Most providers honour
 *       this by simply regenerating the username suffix; the gateway
 *       routes the connection to a fresh NAT identity. Returns the
 *       updated payload.
 *
 *   - release(provider, proxyRow)
 *       Best-effort hint to the gateway that we're done with this
 *       sticky session. Optional — most providers expire on lifetime.
 *
 * Drivers MUST be pure: they never read or write `proxies` /
 * `session_proxy_assignments`. The orchestration layer in proxyService
 * is the only thing that touches those tables.
 */

const crypto = require('crypto');

const SESSION_TOKEN_LEN = 8;

class ProxyProviderDriver {
  /**
   * Vendor identifier matching the `vendor` column on the proxy_providers
   * row. Subclasses set this on the prototype.
   */
  static vendor = 'base';

  /**
   * Human-readable defaults the UI uses to prefill the "Add provider" form.
   * Returns:
   *   { gatewayHost, gatewayPort, gatewayProtocol, suffixHelp }
   * Subclasses override.
   */
  static defaults() {
    return {
      gatewayHost: '',
      gatewayPort: 0,
      gatewayProtocol: 'http',
      suffixHelp: '',
    };
  }

  /**
   * Generate a fresh sticky-session token. 8 hex chars matches the
   * IPRoyal contract; the same length works for SOAX and most others.
   */
  generateSessionToken() {
    return crypto.randomBytes(SESSION_TOKEN_LEN / 2).toString('hex');
  }

  /**
   * Compute the time at which the current sticky session naturally
   * expires. Drivers can override if the vendor uses a different unit.
   */
  computeStickyExpiry(provider) {
    const minutes = Math.max(1, parseInt(provider.sticky_lifetime_minutes, 10) || 30);
    return new Date(Date.now() + minutes * 60_000);
  }

  /**
   * Build the per-session username suffix. Default uses the IPRoyal
   * convention (works as-is for IPRoyal residential and 1:1 for
   * Smartproxy / Decodo). Drivers for vendors with different syntax
   * override this method.
   */
  buildUsernameSuffix(provider, { token }) {
    const parts = [];
    if (provider.country_code) parts.push(`country-${provider.country_code.toLowerCase()}`);
    parts.push(`session-${token}`);
    const minutes = Math.max(1, parseInt(provider.sticky_lifetime_minutes, 10) || 30);
    parts.push(`lifetime-${minutes}m`);
    return parts.join('_');
  }

  /**
   * Compose the full username the panel will send to the upstream
   * gateway: `<base>_<suffix>`. Drivers can override; default works
   * for the gateway+suffix family (IPRoyal, Smartproxy, ProxyEmpire,
   * Custom).
   */
  buildEndpointUsername(provider, baseUsername, suffix) {
    if (!baseUsername) return suffix;
    if (!suffix) return baseUsername;
    return `${baseUsername}_${suffix}`;
  }

  /**
   * Build the row-shaped payload that proxyService persists into the
   * `proxies` table.
   */
  buildProxyPayload(provider, decoded, { sessionToken, expiresAt }) {
    const suffix = this.buildUsernameSuffix(provider, { token: sessionToken });
    const username = this.buildEndpointUsername(
      provider, decoded.endpoint_username || '', suffix
    );
    const label = provider.label
      ? `${provider.label} (${sessionToken})`
      : `${this.constructor.vendor} (${sessionToken})`;
    return {
      host: provider.endpoint_host,
      port: provider.endpoint_port,
      protocol: provider.endpoint_protocol,
      username,
      password: decoded.endpoint_password || null,
      sticky_session_token: sessionToken,
      sticky_expires_at: expiresAt,
      country_code: provider.country_code || null,
      label,
      metadata: {
        provider_id: provider.id,
        vendor: this.constructor.vendor,
        sticky_lifetime_minutes: provider.sticky_lifetime_minutes,
        rotation_policy: provider.rotation_policy,
        suffix,
      },
    };
  }

  // ---------------------------------------------------------------------
  // Hooks subclasses are expected to implement.
  // ---------------------------------------------------------------------

  /**
   * Run a basic reachability probe through the gateway and report back.
   * Default implementation expects the driver layer to call into the
   * shared probeProxyConnection helper from proxyService when wired.
   * Subclasses with provider-side reseller APIs should also fetch the
   * balance and return it.
   *
   * @returns {Promise<{ok:boolean,message:string,balance?:object}>}
   */
  // eslint-disable-next-line no-unused-vars
  async validateCredentials(provider, decoded) {
    return { ok: true, message: 'ok (default validator — driver should override)' };
  }

  /** Optional. */
  // eslint-disable-next-line no-unused-vars
  async fetchBalance(provider, decoded) {
    return null;
  }

  /**
   * Mint a sticky identity for one panel-session.
   *
   * Default implementation works for any gateway+suffix vendor:
   * generates a token, builds the suffix-laced username, and returns
   * the row payload. Drivers that need to call an upstream API to
   * provision (e.g. Bright Data Zone+Endpoint) override.
   */
  async provisionForSession(provider, decoded, ctx = {}) { // eslint-disable-line no-unused-vars
    const sessionToken = this.generateSessionToken();
    const expiresAt = this.computeStickyExpiry(provider);
    return this.buildProxyPayload(provider, decoded, { sessionToken, expiresAt });
  }

  /**
   * Rotate an existing provider-minted proxy in place. Default: regenerate
   * the suffix.
   */
  async rotate(provider, decoded, proxyRow) { // eslint-disable-line no-unused-vars
    return this.provisionForSession(provider, decoded, {});
  }

  /** Optional best-effort release. */
  // eslint-disable-next-line no-unused-vars
  async release(provider, decoded, proxyRow) {
    return { ok: true };
  }
}

module.exports = ProxyProviderDriver;
