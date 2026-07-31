#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${STAGING_COMPOSE_FILE:-${ROOT_DIR}/docker-compose.staging.yml}"
ENV_FILE="${STAGING_ENV_FILE:-${ROOT_DIR}/.env.staging}"

if [[ ! -f "${COMPOSE_FILE}" ]]; then
  printf 'staging isolation: compose file is missing\n' >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  printf 'staging isolation: env file is missing; set STAGING_ENV_FILE to the staging Compose env path\n' >&2
  exit 1
fi
if [[ -L "${ENV_FILE}" ]]; then
  printf 'staging isolation: staging Compose env file must not be a symbolic link\n' >&2
  exit 1
fi

env_name="$(basename "${ENV_FILE}")"
env_name_lc="${env_name,,}"
case "${env_name_lc}" in
  *staging*|*stage*|*test*|*qa*) ;;
  *)
    printf 'staging isolation: env filename must contain a staging or test marker\n' >&2
    exit 1
    ;;
esac
if [[ "${env_name_lc}" =~ (^|[._-])(production|prod)([._-]|$) ]]; then
  printf 'staging isolation: production-marked env filename is forbidden\n' >&2
  exit 1
fi

command -v docker >/dev/null 2>&1 || {
  printf 'staging isolation: docker is required\n' >&2
  exit 1
}

compose=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")

# Validate interpolation first. Compose diagnostics name missing variables but do
# not expose resolved environment values.
if ! "${compose[@]}" config --quiet >/dev/null 2>&1; then
  printf 'staging isolation: compose rendering failed\n' >&2
  exit 1
fi

umask 077
rendered="$(mktemp)"
unresolved="$(mktemp)"
trap 'rm -f "${rendered}" "${unresolved}"' EXIT
if ! "${compose[@]}" config --format json >"${rendered}" 2>/dev/null; then
  printf 'staging isolation: rendered Compose could not be inspected\n' >&2
  exit 1
fi
if ! "${compose[@]}" config --no-env-resolution --format json >"${unresolved}" 2>/dev/null; then
  printf 'staging isolation: backend env-file configuration could not be inspected\n' >&2
  exit 1
fi

node - "${rendered}" "${unresolved}" "${ROOT_DIR}" <<'NODE'
'use strict';

const fs = require('fs');
const path = require('path');

const configPath = process.argv[2];
const unresolvedPath = process.argv[3];
const repoRoot = path.resolve(process.argv[4]);
const errors = [];

let config;
let unresolved;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  unresolved = JSON.parse(fs.readFileSync(unresolvedPath, 'utf8'));
} catch (_) {
  console.error('staging isolation: rendered Compose JSON could not be inspected');
  process.exit(1);
}

const expectedServices = new Set([
  'staging-postgres',
  'staging-redis',
  'staging-backend',
  'staging-frontend',
  'staging-gateway',
]);
const actualServices = Object.keys(config.services || {});
for (const name of actualServices) {
  if (!expectedServices.has(name)) errors.push(`unexpected service: ${name}`);
}
for (const name of expectedServices) {
  if (!config.services?.[name]) errors.push(`required service is missing: ${name}`);
}

if (config.name !== 'web-pannel-staging') {
  errors.push('Compose project name must be web-pannel-staging');
}
if (Object.keys(config.configs || {}).length > 0 || Object.keys(config.secrets || {}).length > 0) {
  errors.push('Compose configs/secrets are not allowed; use the reviewed staging env file and Caddy mount');
}

const forbiddenResourceNames = new Set([
  'web-pannel_postgres_data',
  'web-pannel_redis_data',
  'web-pannel_uploads_data',
  'web-pannel_logs_data',
  'web-pannel_sessions_data',
  'web-pannel_state_data',
  'web-pannel_caddy_data',
  'web-pannel_caddy_config',
  'web-pannel_default',
  'web-pannel',
]);
const forbiddenContainers = new Set([
  'web-pannel-backend-blue',
  'web-pannel-backend-green',
  'web-pannel-frontend-blue',
  'web-pannel-frontend-green',
  'web-pannel-admin-bot',
]);
const productionMarker = /(^|[._-])(production|prod)([._-]|$)/i;
const stagingMarker = /(^|[._-])(staging|stage|test|qa)([._-]|$)/i;

for (const [kind, resources] of [['volume', config.volumes], ['network', config.networks]]) {
  for (const [key, resource] of Object.entries(resources || {})) {
    const renderedName = String(resource?.name || key);
    if (resource?.external === true) errors.push(`${kind} ${key} must not be external`);
    if (kind === 'volume' && resource?.driver && resource.driver !== 'local') {
      errors.push(`volume ${key} uses a non-local driver`);
    }
    if (kind === 'volume' && Object.keys(resource?.driver_opts || {}).length > 0) {
      errors.push(`volume ${key} uses driver options that could mount host data`);
    }
    if (forbiddenResourceNames.has(renderedName) || productionMarker.test(renderedName)) {
      errors.push(`${kind} ${key} uses a production resource name`);
    }
    if (!stagingMarker.test(renderedName)) {
      errors.push(`${kind} ${key} lacks a staging marker`);
    }
    if (!renderedName.startsWith(`${config.name}_`)) {
      errors.push(`${kind} ${key} is not scoped to the staging Compose project`);
    }
  }
}
if (config.networks?.['staging-data']?.internal !== true) {
  errors.push('staging data network must be internal');
}

function normalizedMounts(service) {
  return Array.isArray(service?.volumes) ? service.volumes : [];
}

const allowedConfigMount = path.join(repoRoot, 'proxy', 'Caddyfile.staging');
for (const [serviceName, service] of Object.entries(config.services || {})) {
  const containerName = String(service.container_name || '');
  if (containerName) errors.push(`${serviceName} sets an explicit container name`);
  if (forbiddenContainers.has(containerName) || productionMarker.test(containerName)) {
    errors.push(`${serviceName} uses a production container name`);
  }
  if (service.network_mode) errors.push(`${serviceName} overrides staging network isolation`);
  if ((service.links || []).length > 0 || (service.external_links || []).length > 0) {
    errors.push(`${serviceName} uses host/service aliases outside staging networks`);
  }
  if ((service.volumes_from || []).length > 0) {
    errors.push(`${serviceName} inherits volumes from another container`);
  }
  if ((service.configs || []).length > 0 || (service.secrets || []).length > 0) {
    errors.push(`${serviceName} mounts an unreviewed config or secret file`);
  }
  if (Object.keys(service.extra_hosts || {}).length > 0) {
    errors.push(`${serviceName} defines host aliases`);
  }

  for (const [networkName, attachment] of Object.entries(service.networks || {})) {
    for (const alias of attachment?.aliases || []) {
      errors.push(`${serviceName} defines a network alias`);
    }
    if (!stagingMarker.test(networkName)) errors.push(`${serviceName} joins a non-staging network`);
  }

  for (const mount of normalizedMounts(service)) {
    const source = String(mount.source || '');
    const target = String(mount.target || '');
    if (/docker\.sock$/i.test(source) || /docker\.sock$/i.test(target)) {
      errors.push(`${serviceName} mounts the Docker socket`);
    }
    if (mount.type === 'bind') {
      const resolvedSource = path.resolve(source);
      const allowed = serviceName === 'staging-gateway'
        && resolvedSource === allowedConfigMount
        && target === '/etc/caddy/Caddyfile'
        && mount.read_only === true;
      if (!allowed) errors.push(`${serviceName} has a forbidden bind/repository mount`);
    }
  }
}

for (const serviceName of ['staging-postgres', 'staging-redis']) {
  if ((config.services?.[serviceName]?.ports || []).length > 0) {
    errors.push(`${serviceName} publishes a host port`);
  }
}

for (const [serviceName, service] of Object.entries(config.services || {})) {
  if (serviceName !== 'staging-gateway' && (service.ports || []).length > 0) {
    errors.push(`${serviceName} publishes a host port`);
  }
}

const gatewayPorts = config.services?.['staging-gateway']?.ports || [];
if (gatewayPorts.length !== 1) {
  errors.push('staging-gateway must publish exactly one port');
} else {
  const port = gatewayPorts[0];
  if (!['127.0.0.1', '::1'].includes(String(port.host_ip || ''))) {
    errors.push('staging-gateway must bind only to loopback');
  }
  if (Number(port.target) !== 80 || String(port.protocol || 'tcp') !== 'tcp') {
    errors.push('staging-gateway may only publish its HTTP listener');
  }
}

const backend = config.services?.['staging-backend'];
const backendEnv = backend?.environment || {};
const postgresEnv = config.services?.['staging-postgres']?.environment || {};
const backendEnvFiles = unresolved.services?.['staging-backend']?.env_file || [];
if (backendEnvFiles.length !== 1) {
  errors.push('backend must use exactly one staging env file');
} else {
  const envPath = String(backendEnvFiles[0]?.path || backendEnvFiles[0] || '');
  const envName = path.basename(envPath);
  if (!stagingMarker.test(envName)) {
    errors.push('backend env filename lacks a staging or test marker');
  }
  if (productionMarker.test(envName)) errors.push('backend env filename has a production marker');
  try {
    if (fs.lstatSync(envPath).isSymbolicLink()) errors.push('backend env file must not be a symbolic link');
    const realEnvName = path.basename(fs.realpathSync(envPath));
    if (!stagingMarker.test(realEnvName) || productionMarker.test(realEnvName)) {
      errors.push('backend env file resolves to a non-staging filename');
    }
  } catch (_) {
    errors.push('backend staging env file could not be verified');
  }
}
if (backendEnv.DEPLOY_ENV !== 'staging') errors.push('backend DEPLOY_ENV must be staging');
if (String(backendEnv.ALLOW_TEST_EXTERNAL_ACCOUNTS).toLowerCase() !== 'true') {
  errors.push('backend must explicitly allow test external accounts');
}
if (backendEnv.DB_HOST !== 'staging-postgres') errors.push('backend DB_HOST must use staging-postgres');
if (backendEnv.REDIS_HOST !== 'staging-redis') errors.push('backend REDIS_HOST must use staging-redis');
try {
  const frontend = new URL(String(backendEnv.FRONTEND_URL || ''));
  const host = frontend.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const local = host === 'localhost' || /^(127(?:\.\d{1,3}){3}|::1)$/.test(host);
  if (!['http:', 'https:'].includes(frontend.protocol) || productionMarker.test(host)) {
    errors.push('backend FRONTEND_URL is not a safe staging origin');
  } else if (!local && !stagingMarker.test(host)) {
    errors.push('backend FRONTEND_URL lacks a staging hostname');
  }
} catch (_) {
  errors.push('backend FRONTEND_URL must be an explicit URL');
}
if (!stagingMarker.test(String(backendEnv.DB_NAME || ''))) errors.push('backend DB_NAME lacks a staging marker');
if (!stagingMarker.test(String(postgresEnv.POSTGRES_DB || ''))) errors.push('Postgres database lacks a staging marker');
if (productionMarker.test(String(backendEnv.DB_NAME || ''))) errors.push('backend DB_NAME has a production marker');
if (productionMarker.test(String(postgresEnv.POSTGRES_DB || ''))) errors.push('Postgres database has a production marker');
if (backendEnv.DB_NAME === 'telegram_panel' || postgresEnv.POSTGRES_DB === 'telegram_panel') {
  errors.push('production database name is forbidden');
}

const backendMounts = normalizedMounts(backend);
for (const target of ['/app/uploads', '/app/logs', '/app/sessions']) {
  const mount = backendMounts.find((entry) => entry.target === target);
  if (!mount || mount.type !== 'volume' || !stagingMarker.test(String(mount.source || ''))) {
    errors.push(`backend ${target} must use a staging named volume`);
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`staging isolation: ${error}`);
  process.exit(1);
}

console.log('staging isolation: rendered Compose configuration passed');
NODE
