/**
 * Burner-cookie session-context adapter.
 *
 * `igFetch` consumes a "session context" object — same shape returned
 * by `igFetch.sessionContext(sessionRow)` for operator sessions. The
 * burner pool stores its cookies in the encrypted `lookup_burners`
 * table and returns a flat shape from `burnerPoolService.drawBurner()`;
 * this file maps that flat shape onto what `igFetch` expects.
 *
 * No network here — pure transformation.
 */

'use strict';

const { pickWebFingerprint } = require('../igFetch');

function fromBurner(burner) {
  if (!burner || !burner.cookieHeader) {
    throw new Error('burner: cookie header missing');
  }
  const fp = burner.webFingerprint && Object.keys(burner.webFingerprint).length
    ? burner.webFingerprint
    : pickWebFingerprint(`burner_${burner.id}`);
  return {
    sessionId: `burner:${burner.id}`,
    allowAnonymous: false,
    username: null,
    proxyUrl: burner.proxyUrl || null,
    bypassProxy: !burner.proxyUrl,
    cookieHeader: burner.cookieHeader,
    csrftoken: burner.csrftoken || '',
    dsUserId: burner.dsUserId || null,
    blob: null,
    webFingerprint: fp,
    locale: { language: 'en_US', timezoneOffset: 0, regionHint: 'US' },
    apiMode: 'web',
    _burnerId: burner.id,
  };
}

module.exports = { fromBurner };
