/**
 * Smartproxy / Decodo driver — gateway+suffix family.
 *
 * Username convention: <user>-country-<cc>-session-<token>-sessionduration-<minutes>
 * Default gateway: gate.smartproxy.com:7000 (residential).
 */

const ProxyProviderDriver = require('./base');

class SmartproxyDriver extends ProxyProviderDriver {
  static vendor = 'smartproxy';

  static defaults() {
    return {
      gatewayHost: 'gate.smartproxy.com',
      gatewayPort: 7000,
      gatewayProtocol: 'http',
      suffixHelp:
        'Sticky session via Smartproxy / Decodo username suffix: '
        + 'user-country-<cc>-session-<token>-sessionduration-<minutes>',
    };
  }

  buildUsernameSuffix(provider, { token }) {
    const parts = [];
    if (provider.country_code) parts.push(`country-${provider.country_code.toLowerCase()}`);
    parts.push(`session-${token}`);
    const minutes = Math.max(1, parseInt(provider.sticky_lifetime_minutes, 10) || 30);
    parts.push(`sessionduration-${minutes}`);
    return parts.join('-');
  }

  buildEndpointUsername(provider, baseUsername, suffix) {
    if (baseUsername) return `${baseUsername}-${suffix}`;
    return suffix;
  }
}

module.exports = SmartproxyDriver;
