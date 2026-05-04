/**
 * Tiny client for Caddy's admin API.
 *
 * The orchestrator uses this to:
 *   1. Read the current loaded config.
 *   2. POST a fresh config that flips `/api/*` and `/socket.io/*` to the new
 *      backend color. Caddy hot-reloads atomically — existing in-flight
 *      requests finish on the old upstream, new requests go to the new one.
 *
 * The admin API is only reachable from inside the Docker network on
 * `http://caddy:2019`. It is never exposed publicly.
 *
 * Implementation: pure Node.js (no extra deps), uses `http` directly.
 */

const http = require('http');

const ADMIN_HOST = process.env.CADDY_ADMIN_HOST || '127.0.0.1';
const ADMIN_PORT = parseInt(process.env.CADDY_ADMIN_PORT || '2019', 10);

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const r = http.request(
      {
        host: ADMIN_HOST,
        port: ADMIN_PORT,
        method,
        path,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': data.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(text ? JSON.parse(text) : null);
            } catch (_) {
              resolve(text);
            }
          } else {
            reject(new Error(`caddy admin ${method} ${path} → ${res.statusCode}: ${text}`));
          }
        });
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function getConfig() {
  return req('GET', '/config/');
}

/**
 * Build a complete Caddy JSON config that routes /api/* and /socket.io/* to
 * the given backend upstream and everything else to the frontend.
 *
 * `backendUpstream` — e.g. "backend-blue:3005".
 * `frontendUpstream` — e.g. "frontend:83".
 * `publicDomain` — used to build the host matcher for TLS. Empty string ⇒
 * HTTP only on :80.
 */
function buildConfig({ backendUpstream, frontendUpstream, publicDomain, acmeEmail }) {
  const apiRoute = {
    match: [{ path: ['/api/*', '/socket.io/*'] }],
    handle: [
      {
        handler: 'reverse_proxy',
        upstreams: [{ dial: backendUpstream }],
        health_checks: {
          active: {
            uri: '/health',
            interval: '10s',
            timeout: '2s',
            expect_status: 200,
          },
        },
        headers: {
          request: {
            set: {
              'X-Forwarded-Proto': ['{http.request.scheme}'],
              'X-Forwarded-For':   ['{http.request.remote.host}'],
              'X-Real-IP':         ['{http.request.remote.host}'],
            },
          },
        },
      },
    ],
    terminal: true,
  };
  const fallbackRoute = {
    handle: [
      {
        handler: 'reverse_proxy',
        upstreams: [{ dial: frontendUpstream }],
      },
    ],
  };

  const httpServer = {
    listen: [':80'],
    routes: [apiRoute, fallbackRoute],
    automatic_https: { disable: true },
  };
  const tlsServer = publicDomain
    ? {
        listen: [':443'],
        routes: [
          {
            match: [{ host: [publicDomain] }],
            handle: [
              {
                handler: 'subroute',
                routes: [apiRoute, fallbackRoute],
              },
            ],
          },
        ],
      }
    : null;

  const servers = { http: httpServer };
  if (tlsServer) servers.https = tlsServer;

  const cfg = {
    admin: { listen: '0.0.0.0:2019' },
    apps: {
      http: { servers },
    },
  };
  if (publicDomain && acmeEmail) {
    cfg.apps.tls = {
      automation: {
        policies: [
          {
            subjects: [publicDomain],
            issuers: [{ module: 'acme', email: acmeEmail }],
          },
        ],
      },
    };
  }
  return cfg;
}

async function loadConfig(cfg) {
  return req('POST', '/load', cfg);
}

module.exports = { req, getConfig, loadConfig, buildConfig };
