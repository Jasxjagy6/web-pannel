/**
 * ProxyEmpire driver — gateway+suffix family.
 *
 * ProxyEmpire username convention:
 *   <username>-country-<cc>-session-<token>-lifetime-<minutes>m
 *
 * Mobile gateway defaults to rotating-residential.proxyempire.io. The
 * user can override on the Provider form to switch between residential,
 * mobile and ISP plans.
 */

const ProxyProviderDriver = require('./base');

class ProxyEmpireDriver extends ProxyProviderDriver {
  static vendor = 'proxyempire';

  static defaults() {
    return {
      gatewayHost: 'rotating-residential.proxyempire.io',
      gatewayPort: 9175,
      gatewayProtocol: 'http',
      suffixHelp:
        'Sticky session via ProxyEmpire username suffix: '
        + 'username-country-<cc>-session-<token>-lifetime-<minutes>m',
    };
  }

  buildUsernameSuffix(provider, { token }) {
    const parts = [];
    if (provider.country_code) parts.push(`country-${provider.country_code.toLowerCase()}`);
    parts.push(`session-${token}`);
    const minutes = Math.max(1, parseInt(provider.sticky_lifetime_minutes, 10) || 30);
    parts.push(`lifetime-${minutes}m`);
    return parts.join('-');
  }

  buildEndpointUsername(provider, baseUsername, suffix) {
    if (baseUsername) return `${baseUsername}-${suffix}`;
    return suffix;
  }
}

module.exports = ProxyEmpireDriver;
