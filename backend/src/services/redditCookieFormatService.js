/**
 * Multi-format export for Reddit cookies.
 *
 * Each exporter receives a normalised cookie list (decrypted) and
 * returns `{ contentType, filename, body }`. Supported formats:
 *
 *   - json                    machine-readable list of all attributes
 *   - netscape                Netscape `cookies.txt` (curl --cookie-jar)
 *   - editthiscookie          EditThisCookie / Cookie-Editor browser ext
 *   - cookieheader            single Cookie: header value
 *   - curl                    bash one-liner that re-uses every cookie
 *   - selenium                Selenium WebDriver JSON
 *   - puppeteer               Puppeteer/Playwright JSON
 *   - har                     HAR-compatible request payload
 *   - csv                     spreadsheet-friendly
 *   - python_requests         drop-in Python script using requests
 *   - powershell              PowerShell Invoke-WebRequest -WebSession
 *   - dotenv                  REDDIT_COOKIE=... env file
 *   - js_document_cookie      browser dev-tools paste-in
 *
 * Cookie shape consumed (see redditScrapeService → toExportShape):
 *   {
 *     name, value, domain, path, expires_at (ISO or null),
 *     http_only, secure, same_site, host_only,
 *     source_url, set_cookie, value_len
 *   }
 */

'use strict';

const SUPPORTED = [
  'json',
  'netscape',
  'editthiscookie',
  'cookieheader',
  'curl',
  'selenium',
  'puppeteer',
  'har',
  'csv',
  'python_requests',
  'powershell',
  'dotenv',
  'js_document_cookie',
];

function _filenameFor(username, fmt, ext) {
  const u = String(username || 'reddit').replace(/[^a-z0-9_.-]+/gi, '_');
  return `reddit_${u}_${fmt}.${ext}`;
}

function _toEpoch(expires) {
  if (!expires) return 0;
  const d = new Date(expires);
  if (Number.isNaN(d.getTime())) return 0;
  return Math.floor(d.getTime() / 1000);
}

function _domainForNetscape(c) {
  // Netscape cookies.txt expects leading-dot for non-host-only cookies.
  if (c.host_only) return c.domain;
  return c.domain && c.domain.startsWith('.') ? c.domain : `.${c.domain}`;
}

function exportJson(cookies, meta) {
  const body = JSON.stringify({
    schema: 'reddit-cookie-export/v1',
    exported_at: new Date().toISOString(),
    account: meta.account,
    job: meta.job,
    profile: meta.profile,
    cookie_count: cookies.length,
    cookies: cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires_at,
      expires_epoch: _toEpoch(c.expires_at),
      http_only: c.http_only,
      secure: c.secure,
      same_site: c.same_site,
      host_only: c.host_only,
      source_url: c.source_url,
      set_cookie: c.set_cookie,
      value_len: c.value_len,
    })),
  }, null, 2);
  return {
    contentType: 'application/json; charset=utf-8',
    filename: _filenameFor(meta.account.username, 'cookies', 'json'),
    body,
  };
}

function exportNetscape(cookies, meta) {
  const lines = [
    '# Netscape HTTP Cookie File',
    '# https://curl.se/docs/http-cookies.html',
    `# Exported by web-panel reddit-scraper for ${meta.account.username} at ${new Date().toISOString()}`,
    '',
  ];
  for (const c of cookies) {
    const domain = _domainForNetscape(c);
    const flag = c.host_only ? 'FALSE' : 'TRUE';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const expires = _toEpoch(c.expires_at);
    lines.push([
      domain,
      flag,
      c.path || '/',
      secure,
      String(expires),
      c.name,
      c.value,
    ].join('\t'));
  }
  return {
    contentType: 'text/plain; charset=utf-8',
    filename: _filenameFor(meta.account.username, 'netscape', 'txt'),
    body: lines.join('\n') + '\n',
  };
}

function exportEditThisCookie(cookies, meta) {
  // EditThisCookie / Cookie-Editor share the same JSON wire shape.
  const arr = cookies.map((c) => ({
    domain: c.domain,
    expirationDate: _toEpoch(c.expires_at) || undefined,
    hostOnly: c.host_only,
    httpOnly: c.http_only,
    name: c.name,
    path: c.path || '/',
    sameSite: (c.same_site || 'unspecified').toLowerCase(),
    secure: c.secure,
    session: !c.expires_at,
    storeId: '0',
    value: c.value,
  }));
  return {
    contentType: 'application/json; charset=utf-8',
    filename: _filenameFor(meta.account.username, 'editthiscookie', 'json'),
    body: JSON.stringify(arr, null, 2),
  };
}

function exportCookieHeader(cookies, meta) {
  const parts = cookies.map((c) => `${c.name}=${c.value}`);
  return {
    contentType: 'text/plain; charset=utf-8',
    filename: _filenameFor(meta.account.username, 'cookieheader', 'txt'),
    body: parts.join('; ') + '\n',
  };
}

function exportCurl(cookies, meta) {
  const header = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const cmd = [
    `curl 'https://www.reddit.com/api/v1/me' \\`,
    `  -H 'user-agent: Mozilla/5.0' \\`,
    `  -H 'cookie: ${header}'`,
  ];
  return {
    contentType: 'text/x-shellscript; charset=utf-8',
    filename: _filenameFor(meta.account.username, 'curl', 'sh'),
    body: cmd.join('\n') + '\n',
  };
}

function exportSelenium(cookies, meta) {
  // selenium WebDriver `add_cookie` accepts this exact shape.
  const arr = cookies.map((c) => {
    const cookie = {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      secure: !!c.secure,
      httpOnly: !!c.http_only,
    };
    const exp = _toEpoch(c.expires_at);
    if (exp) cookie.expiry = exp;
    if (c.same_site) cookie.sameSite = c.same_site;
    return cookie;
  });
  return {
    contentType: 'application/json; charset=utf-8',
    filename: _filenameFor(meta.account.username, 'selenium', 'json'),
    body: JSON.stringify({
      schema: 'selenium-webdriver-cookies/v1',
      account: meta.account.username,
      exported_at: new Date().toISOString(),
      cookies: arr,
    }, null, 2),
  };
}

function exportPuppeteer(cookies, meta) {
  const arr = cookies.map((c) => {
    const out = {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      secure: !!c.secure,
      httpOnly: !!c.http_only,
      hostOnly: !!c.host_only,
    };
    const exp = _toEpoch(c.expires_at);
    if (exp) out.expires = exp;
    if (c.same_site) out.sameSite = c.same_site;
    return out;
  });
  return {
    contentType: 'application/json; charset=utf-8',
    filename: _filenameFor(meta.account.username, 'puppeteer', 'json'),
    body: JSON.stringify(arr, null, 2),
  };
}

function exportHar(cookies, meta) {
  const har = {
    log: {
      version: '1.2',
      creator: { name: 'web-panel-reddit-scraper', version: '1.0' },
      entries: [{
        startedDateTime: new Date().toISOString(),
        time: 0,
        request: {
          method: 'GET',
          url: 'https://www.reddit.com/api/v1/me',
          httpVersion: 'HTTP/1.1',
          headers: [
            { name: 'User-Agent', value: 'Mozilla/5.0' },
            { name: 'Cookie', value: cookies.map((c) => `${c.name}=${c.value}`).join('; ') },
          ],
          cookies: cookies.map((c) => ({
            name: c.name,
            value: c.value,
            path: c.path || '/',
            domain: c.domain,
            expires: c.expires_at || undefined,
            httpOnly: !!c.http_only,
            secure: !!c.secure,
          })),
          queryString: [],
          headersSize: -1,
          bodySize: 0,
        },
        response: {
          status: 200,
          statusText: 'OK',
          httpVersion: 'HTTP/1.1',
          headers: [],
          cookies: [],
          content: { size: 0, mimeType: 'application/json' },
          redirectURL: '',
          headersSize: -1,
          bodySize: 0,
        },
        cache: {},
        timings: { send: 0, wait: 0, receive: 0 },
      }],
    },
  };
  return {
    contentType: 'application/json; charset=utf-8',
    filename: _filenameFor(meta.account.username, 'session', 'har'),
    body: JSON.stringify(har, null, 2),
  };
}

function exportCsv(cookies, meta) {
  const header = [
    'name', 'value', 'domain', 'path', 'expires_iso', 'expires_epoch',
    'http_only', 'secure', 'same_site', 'host_only', 'source_url', 'value_len',
  ];
  const esc = (s) => {
    if (s === null || s === undefined) return '';
    const str = String(s);
    if (/[,\"\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
  };
  const rows = [header.join(',')];
  for (const c of cookies) {
    rows.push([
      esc(c.name), esc(c.value), esc(c.domain), esc(c.path),
      esc(c.expires_at || ''), esc(_toEpoch(c.expires_at) || ''),
      esc(c.http_only), esc(c.secure), esc(c.same_site || ''),
      esc(c.host_only), esc(c.source_url || ''), esc(c.value_len),
    ].join(','));
  }
  return {
    contentType: 'text/csv; charset=utf-8',
    filename: _filenameFor(meta.account.username, 'cookies', 'csv'),
    body: rows.join('\n') + '\n',
  };
}

function exportPythonRequests(cookies, meta) {
  const dict = cookies
    .map((c) => `    ${JSON.stringify(c.name)}: ${JSON.stringify(c.value)},`)
    .join('\n');
  const body = `# Python `+`requests`+` drop-in for Reddit user ${meta.account.username}
# Exported ${new Date().toISOString()}
import requests

cookies = {
${dict}
}

headers = {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
}

session = requests.Session()
session.headers.update(headers)
for k, v in cookies.items():
    session.cookies.set(k, v, domain=".reddit.com")

resp = session.get("https://www.reddit.com/api/v1/me", timeout=30)
print(resp.status_code, resp.json())
`;
  return {
    contentType: 'text/x-python; charset=utf-8',
    filename: _filenameFor(meta.account.username, 'requests', 'py'),
    body,
  };
}

function exportPowershell(cookies, meta) {
  const lines = [
    `# Reddit cookies for ${meta.account.username} (exported ${new Date().toISOString()})`,
    `$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession`,
    `$session.UserAgent = "Mozilla/5.0"`,
  ];
  for (const c of cookies) {
    lines.push(
      `$session.Cookies.Add((New-Object System.Net.Cookie '${c.name.replace(/'/g, "''")}',`
      + ` '${c.value.replace(/'/g, "''")}',`
      + ` '${(c.path || '/').replace(/'/g, "''")}',`
      + ` '${(c.domain || '.reddit.com').replace(/'/g, "''")}'))`
    );
  }
  lines.push(`Invoke-WebRequest -Uri 'https://www.reddit.com/api/v1/me' -WebSession $session | Select-Object -ExpandProperty Content`);
  return {
    contentType: 'text/x-powershell; charset=utf-8',
    filename: _filenameFor(meta.account.username, 'session', 'ps1'),
    body: lines.join('\n') + '\n',
  };
}

function exportDotenv(cookies, meta) {
  const header = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const lines = [
    `# Reddit account: ${meta.account.username}`,
    `# Exported: ${new Date().toISOString()}`,
    `REDDIT_USERNAME=${meta.account.username}`,
    `REDDIT_COOKIE="${header.replace(/"/g, '\\"')}"`,
  ];
  // Pull commonly-referenced cookies out into individual env vars so
  // consumers don't have to parse the combined header.
  for (const c of cookies) {
    if (['reddit_session', 'token_v2', 'edgebucket', 'csv'].includes(c.name)) {
      lines.push(`REDDIT_${c.name.toUpperCase()}=${c.value}`);
    }
  }
  return {
    contentType: 'text/plain; charset=utf-8',
    filename: _filenameFor(meta.account.username, 'env', 'env'),
    body: lines.join('\n') + '\n',
  };
}

function exportJsDocumentCookie(cookies, meta) {
  const lines = [
    `// Paste into DevTools console on https://www.reddit.com (user: ${meta.account.username})`,
    `// Exported ${new Date().toISOString()}`,
    '(function () {',
    `  const cookies = ${JSON.stringify(cookies.map((c) => ({
      name: c.name, value: c.value, path: c.path || '/',
      domain: c.domain, secure: c.secure,
    })), null, 2)};`,
    '  for (const c of cookies) {',
    "    const parts = [`${c.name}=${c.value}`, `path=${c.path}`, `domain=${c.domain}`];",
    '    if (c.secure) parts.push("secure");',
    '    document.cookie = parts.join("; ");',
    '  }',
    '  console.log(`set ${cookies.length} cookies`);',
    '})();',
  ];
  return {
    contentType: 'application/javascript; charset=utf-8',
    filename: _filenameFor(meta.account.username, 'document_cookie', 'js'),
    body: lines.join('\n') + '\n',
  };
}

const EXPORTERS = {
  json:                 exportJson,
  netscape:             exportNetscape,
  editthiscookie:       exportEditThisCookie,
  cookieheader:         exportCookieHeader,
  curl:                 exportCurl,
  selenium:             exportSelenium,
  puppeteer:            exportPuppeteer,
  har:                  exportHar,
  csv:                  exportCsv,
  python_requests:      exportPythonRequests,
  powershell:           exportPowershell,
  dotenv:               exportDotenv,
  js_document_cookie:   exportJsDocumentCookie,
};

function exportCookies(format, cookies, meta) {
  const fn = EXPORTERS[format];
  if (!fn) throw new Error(`unsupported format: ${format}`);
  return fn(cookies, meta);
}

module.exports = {
  SUPPORTED,
  exportCookies,
  EXPORTERS,
};
