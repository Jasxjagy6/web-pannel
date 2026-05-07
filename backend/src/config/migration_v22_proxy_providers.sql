-- =====================================================================
-- Migration v22 — Auto-rotating proxy providers
-- =====================================================================
-- Adds the proxy_providers table (one row per (user, vendor) provider
-- configuration) and extends `proxies` with the per-IP lifecycle metadata
-- needed to mint sticky-session rows on the fly from a single API key /
-- gateway endpoint.
--
-- The gateway+suffix pattern (used by IPRoyal, SOAX, ProxyEmpire,
-- Smartproxy, Decodo, Proxy-Cheap and most modern rotating residential /
-- mobile providers) lets the panel mint a unique sticky IP per panel
-- session WITHOUT making an upstream API call per session — the
-- driver just regenerates the username suffix and the gateway routes
-- to a fresh NAT identity from the same pool.
--
-- All statements are idempotent; safe to re-run on an upgraded DB.
-- =====================================================================

-- 1. Provider configuration. One row per (user, vendor). Keeps the
--    sensitive credentials encrypted at rest (TEXT columns hold the
--    output of utils/crypto.encrypt — same wrapping used elsewhere
--    for proxy username/password/secret/api_hash).
CREATE TABLE IF NOT EXISTS proxy_providers (
  id                       SERIAL PRIMARY KEY,
  user_id                  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Vendor identifier picked by the user in the UI. Must match a
  -- registered driver (see backend/src/services/proxyProviders/index.js).
  -- 'custom' selects the generic-rotating-endpoint driver and lets the
  -- user supply any vendor's gateway + suffix template.
  vendor                   VARCHAR(40) NOT NULL,
  label                    VARCHAR(120),
  enabled                  BOOLEAN NOT NULL DEFAULT TRUE,

  -- Gateway endpoint the panel will dial. Filled by the driver's
  -- defaults when the user picks a known vendor; manually for 'custom'.
  endpoint_host            VARCHAR(255) NOT NULL,
  endpoint_port            INTEGER NOT NULL,
  endpoint_protocol        VARCHAR(10) NOT NULL DEFAULT 'http'
    CHECK (endpoint_protocol IN ('http', 'https', 'socks5')),

  -- Auth (encrypted via utils/crypto). All optional — some providers
  -- expose a single api_key, others want endpoint username/password.
  endpoint_username_enc    TEXT,
  endpoint_password_enc    TEXT,
  api_key_enc              TEXT,
  api_extra_enc            JSONB,

  -- Behaviour knobs. country_code follows ISO-3166 alpha-2; '' = no lock.
  country_code             VARCHAR(8),
  sticky_lifetime_minutes  INTEGER NOT NULL DEFAULT 30
    CHECK (sticky_lifetime_minutes BETWEEN 1 AND 1440),
  rotation_policy          VARCHAR(20) NOT NULL DEFAULT 'per_session'
    CHECK (rotation_policy IN ('per_session','per_login','per_n_uses','time_based','per_request')),
  rotate_after_uses        INTEGER NOT NULL DEFAULT 0,
  max_sessions_per_ip      INTEGER NOT NULL DEFAULT 1
    CHECK (max_sessions_per_ip BETWEEN 1 AND 10),

  -- Health snapshot. Used by the Providers UI for the green/red dot +
  -- balance badge. Refreshed every time the driver runs a probe.
  last_health_check_at     TIMESTAMP,
  last_health_ok           BOOLEAN,
  last_health_message      TEXT,
  last_balance_json        JSONB,

  created_at               TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_proxy_providers_user
  ON proxy_providers(user_id, enabled);

-- 2. Extend `proxies` with the lifecycle metadata for provider-minted rows.
--    All columns are NULL for legacy rows (user-BYO, manual, free), so the
--    existing assignment / health / risk plumbing keeps working unchanged.
ALTER TABLE proxies
  ADD COLUMN IF NOT EXISTS provider_id INTEGER,
  ADD COLUMN IF NOT EXISTS sticky_session_token VARCHAR(64),
  ADD COLUMN IF NOT EXISTS sticky_expires_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS provider_use_count INTEGER NOT NULL DEFAULT 0;

-- FK proxies.provider_id → proxy_providers(id), wrapped as idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_proxies_provider_id'
       AND conrelid = 'proxies'::regclass
  ) THEN
    ALTER TABLE proxies
      ADD CONSTRAINT fk_proxies_provider_id
      FOREIGN KEY (provider_id) REFERENCES proxy_providers(id) ON DELETE SET NULL;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_proxies_provider
  ON proxies(provider_id) WHERE provider_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_proxies_sticky_expires
  ON proxies(sticky_expires_at)
  WHERE sticky_expires_at IS NOT NULL;

-- 3. Widen the proxies.source CHECK so we can stamp provider-minted rows
--    with source='provider'. Legacy values stay valid.
ALTER TABLE proxies DROP CONSTRAINT IF EXISTS proxies_source_check;
ALTER TABLE proxies
  ADD CONSTRAINT proxies_source_check
  CHECK (source IN ('free', 'manual', 'user', 'provider'));

-- 4. Provider-minted rows share the same gateway (host, port, protocol)
--    across hundreds of sticky sessions for one user, so the legacy
--    user-scoped UNIQUE (host, port, protocol) blocks the second insert.
--    Replace it with two partial indexes:
--      a) BYO/manual user rows keep the legacy uniqueness
--         (so a user can't accidentally double-add the same upstream
--          residential proxy row by hand)
--      b) Provider rows are unique on (user_id, provider_id,
--         sticky_session_token), giving each mint its own row while
--         still preventing token collisions.
DROP INDEX IF EXISTS uniq_proxies_user_host_port_protocol;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_proxies_user_host_port_protocol_byo
  ON proxies (user_id, host, port, protocol)
  WHERE user_id IS NOT NULL AND source <> 'provider';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_proxies_provider_sticky
  ON proxies (user_id, provider_id, sticky_session_token)
  WHERE source = 'provider' AND sticky_session_token IS NOT NULL;
