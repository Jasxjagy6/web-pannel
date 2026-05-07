/**
 * SOAX driver — gateway+suffix family.
 *
 * SOAX uses a "package" model: every order has a numeric package_id and
 * the username carries it: `package-<id>-country-<cc>-sessionid-<token>-
 * sessionlength-<seconds>`.
 *
 * Default gateway: proxy.soax.com:5000 (residential) — the user can
 * override on the Provider form for mobile / other ports.
 */

const ProxyProviderDriver = require('./base');

class SoaxDriver extends ProxyProviderDriver {
  static vendor = 'soax';

  static defaults() {
    return {
      gatewayHost: 'proxy.soax.com',
      gatewayPort: 5000,
      gatewayProtocol: 'http',
      suffixHelp:
        'Sticky session via SOAX username suffix: '
        + 'package-<id>-country-<cc>-sessionid-<token>-sessionlength-<seconds>',
    };
  }

  buildUsernameSuffix(provider, { token }) {
    const extras = [];
    const apiExtra = provider._apiExtraDecoded || {};
    if (apiExtra.package_id) extras.push(`package-${apiExtra.package_id}`);
    if (provider.country_code) extras.push(`country-${provider.country_code.toLowerCase()}`);
    extras.push(`sessionid-${token}`);
    const seconds = Math.max(60,
      (parseInt(provider.sticky_lifetime_minutes, 10) || 30) * 60);
    extras.push(`sessionlength-${seconds}`);
    return extras.join('-');
  }

  buildEndpointUsername(provider, baseUsername, suffix) {
    // SOAX puts everything in the username; no "base_" prefix needed.
    if (baseUsername) return `${baseUsername}-${suffix}`;
    return suffix;
  }
}

module.exports = SoaxDriver;
