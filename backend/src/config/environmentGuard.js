'use strict';

function assertEnvironmentIsolation(env = process.env) {
  if (String(env.DEPLOY_ENV || '').trim().toLowerCase() !== 'staging') return;

  const errors = [];
  const stagingName = /(^|[._-])(staging|stage|test|qa)([._-]|$)/i;
  const productionName = /(^|[._-])(production|prod)([._-]|$)/i;
  const forbiddenHost = /(^|[.-])(localhost|production|prod)([.-]|$)/i;
  const loopbackHost = /^(127(?:\.\d{1,3}){3}|::1)$/;
  const placeholder = /^(admin123$|change|replace|example|placeholder|your[_-])/i;

  const dbName = String(env.DB_NAME || '').trim();
  const dbHost = String(env.DB_HOST || '').trim();
  const redisHost = String(env.REDIS_HOST || '').trim();

  if (!stagingName.test(dbName) || productionName.test(dbName) || dbName === 'telegram_panel') {
    errors.push('DB_NAME must be staging/test-specific and must not contain a production marker');
  }
  if (!stagingName.test(dbHost) || forbiddenHost.test(dbHost) || loopbackHost.test(dbHost)) {
    errors.push('DB_HOST must be a staging service hostname');
  }
  if (!stagingName.test(redisHost) || forbiddenHost.test(redisHost) || loopbackHost.test(redisHost)) {
    errors.push('REDIS_HOST must be a staging service hostname');
  }
  if (String(env.ALLOW_TEST_EXTERNAL_ACCOUNTS || '').trim().toLowerCase() !== 'true') {
    errors.push('ALLOW_TEST_EXTERNAL_ACCOUNTS must be explicitly true');
  }

  try {
    const frontend = new URL(String(env.FRONTEND_URL || ''));
    const host = frontend.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const local = host === 'localhost' || loopbackHost.test(host);
    if (
      !['http:', 'https:'].includes(frontend.protocol)
      || productionName.test(host)
      || (!local && !stagingName.test(host))
    ) {
      errors.push('FRONTEND_URL must use a local, staging, test, or QA hostname');
    }
  } catch (_) {
    errors.push('FRONTEND_URL must be an explicit valid URL');
  }

  for (const name of [
    'DB_PASSWORD',
    'REDIS_PASSWORD',
    'JWT_SECRET',
    'SESSION_ENCRYPTION_KEY',
    'ADMIN_PASSWORD',
  ]) {
    const value = String(env[name] || '').trim();
    if (!value || placeholder.test(value)) errors.push(`${name} must be set to a non-placeholder staging value`);
  }

  if (env.JWT_SECRET && env.JWT_SECRET === env.SESSION_ENCRYPTION_KEY) {
    errors.push('JWT_SECRET and SESSION_ENCRYPTION_KEY must differ');
  }

  if (errors.length > 0) {
    throw new Error(`Staging environment isolation check failed: ${errors.join('; ')}`);
  }
}

module.exports = { assertEnvironmentIsolation };
