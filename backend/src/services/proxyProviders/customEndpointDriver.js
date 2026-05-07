/**
 * Custom rotating-endpoint driver — fallback for any vendor not yet
 * first-class. The user supplies the gateway host/port + endpoint
 * username/password, and a printf-style "suffix template" with these
 * placeholders:
 *
 *   {country}   -> ISO-3166 alpha-2, lowercased ('' when not set)
 *   {token}     -> 8-char random hex (per panel-session)
 *   {minutes}   -> sticky lifetime, integer minutes
 *   {seconds}   -> sticky lifetime, integer seconds
 *
 * Example templates:
 *   "country-{country}_session-{token}_lifetime-{minutes}m"      (IPRoyal)
 *   "country-{country}-sessionid-{token}-sessionlength-{seconds}" (SOAX-like)
 *   "session-{token}_country-{country}_lifetime-{minutes}m"
 *
 * Stored verbatim in proxy_providers.api_extra_enc.suffix_template.
 */

const ProxyProviderDriver = require('./base');

const DEFAULT_TEMPLATE = '{country}_session-{token}_lifetime-{minutes}m';
const DEFAULT_JOIN = '_';

class CustomEndpointDriver extends ProxyProviderDriver {
  static vendor = 'custom';

  static defaults() {
    return {
      gatewayHost: '',
      gatewayPort: 0,
      gatewayProtocol: 'http',
      suffixHelp:
        'Custom suffix template — placeholders: {country}, {token}, '
        + '{minutes}, {seconds}. Example: '
        + 'country-{country}_session-{token}_lifetime-{minutes}m',
    };
  }

  buildUsernameSuffix(provider, { token }) {
    const apiExtra = provider._apiExtraDecoded || {};
    const tpl = apiExtra.suffix_template || DEFAULT_TEMPLATE;
    const minutes = Math.max(1, parseInt(provider.sticky_lifetime_minutes, 10) || 30);
    const seconds = minutes * 60;
    const country = (provider.country_code || '').toLowerCase();
    const out = tpl
      .replace(/\{country\}/g, country)
      .replace(/\{token\}/g, token)
      .replace(/\{minutes\}/g, String(minutes))
      .replace(/\{seconds\}/g, String(seconds));
    // Collapse separator runs that result from an empty {country}.
    return out
      .replace(/__+/g, '_')
      .replace(/--+/g, '-')
      .replace(/^[_\-]+|[_\-]+$/g, '');
  }

  buildEndpointUsername(provider, baseUsername, suffix) {
    const apiExtra = provider._apiExtraDecoded || {};
    const join = typeof apiExtra.suffix_join === 'string'
      ? apiExtra.suffix_join : DEFAULT_JOIN;
    if (!baseUsername) return suffix;
    if (!suffix) return baseUsername;
    return `${baseUsername}${join}${suffix}`;
  }
}

module.exports = CustomEndpointDriver;
