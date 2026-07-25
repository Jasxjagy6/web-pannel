-- =====================================================================
-- Migration v55 - Dedicated proxies for future Telegram sessions
-- =====================================================================
-- Existing sessions are explicitly grandfathered onto their current
-- networking behavior. Sessions inserted after this migration default to
-- strict proxy mode and may not connect without a healthy 1:1 user proxy.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS proxy_required BOOLEAN;

-- This UPDATE runs before the default is installed so every session that
-- existed at rollout remains untouched by the new enforcement policy.
UPDATE sessions SET proxy_required = FALSE WHERE proxy_required IS NULL;

ALTER TABLE sessions
  ALTER COLUMN proxy_required SET DEFAULT TRUE,
  ALTER COLUMN proxy_required SET NOT NULL;

ALTER TABLE proxies
  ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE session_proxy_assignments
  ADD COLUMN IF NOT EXISTS dedicated BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_session_proxy_dedicated_proxy
  ON session_proxy_assignments(proxy_id)
  WHERE dedicated = TRUE;

CREATE INDEX IF NOT EXISTS idx_sessions_proxy_required
  ON sessions(user_id, proxy_required, is_logged_in)
  WHERE platform = 'telegram';

CREATE INDEX IF NOT EXISTS idx_proxies_dedicated_available
  ON proxies(user_id, enabled, is_working, validated_for_telegram, id)
  WHERE source = 'user';

-- Retire automatic/shared sources from future allocation. Bound historical
-- rows remain present so this migration never changes an existing session.
UPDATE proxies
   SET enabled = FALSE
 WHERE source IN ('free', 'provider') OR host = '__direct__';

UPDATE proxy_providers SET enabled = FALSE WHERE enabled = TRUE;

DELETE FROM proxies p
 WHERE p.source IN ('free', 'provider')
   AND NOT EXISTS (
     SELECT 1 FROM session_proxy_assignments a WHERE a.proxy_id = p.id
   );
