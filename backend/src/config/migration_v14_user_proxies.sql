-- =====================================================================
-- Migration v14 — Per-user proxy ownership (BYO Proxy, Phase 1)
-- =====================================================================
-- See BYO_PROXY_PROPOSAL.md §4 (Phase 1) for the full design.
--
-- Adds:
--   * proxies.user_id           → FK to users(id) ON DELETE CASCADE.
--                                 NULL means "shared admin pool" (the
--                                 existing free + manual rows).
--   * proxies.label             → human-readable label for the user UI.
--   * proxies.country_code      → ISO-3166 alpha-2 ('in', 'us', …) for
--                                 region-matched binding (Phase 2 picker).
--   * proxies.notes             → free-text notes the user can attach.
--   * proxies.last_health_check / .last_health_ok / .health_message
--     → output of the proxyService.testMyProxy() probe (Phase 2).
--   * Source CHECK widened to allow source = 'user' (BYO proxies).
--   * Replaces the legacy global UNIQUE (host, port, protocol) with two
--     partial uniques so:
--       - the shared admin pool stays globally unique
--       - each user can have their own (host, port, protocol) without
--         clashing with another user
--   * Indexes on (user_id) and (user_id, is_working).
--   * Trigger trg_enforce_session_proxy_ownership: when a row is
--     inserted/updated in session_proxy_assignments, the proxy's
--     user_id must be NULL (shared admin pool) OR equal to the
--     session's user_id. This is the *DB*-side ownership guard so
--     even a buggy service call cannot bind user-A's session to
--     user-B's proxy.
--
-- Phase 1 deliberately stops at schema. Backend enforcement
-- (REQUIRE_USER_PROXY, subscription gate, user-scoped CRUD) lands
-- in Phase 2 (PR #31). Frontend in Phase 3, e2e in Phase 4.
--
-- All statements are idempotent — re-running on an upgraded DB is safe.
-- =====================================================================

-- 1. Add new columns. ALTER … ADD COLUMN IF NOT EXISTS is metadata-only
--    on PG ≥ 11, so this is safe on a hot table.
ALTER TABLE proxies
  ADD COLUMN IF NOT EXISTS user_id INTEGER,
  ADD COLUMN IF NOT EXISTS label VARCHAR(120),
  ADD COLUMN IF NOT EXISTS country_code VARCHAR(8),
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS last_health_check TIMESTAMP,
  ADD COLUMN IF NOT EXISTS last_health_ok BOOLEAN,
  ADD COLUMN IF NOT EXISTS health_message TEXT;

-- 2. FK: proxies.user_id → users(id) ON DELETE CASCADE.
--    Wrapped in an idempotent DO block because PG has no
--    `ALTER TABLE … ADD CONSTRAINT IF NOT EXISTS` (until 17).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_proxies_user_id'
       AND conrelid = 'proxies'::regclass
  ) THEN
    ALTER TABLE proxies
      ADD CONSTRAINT fk_proxies_user_id
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END$$;

-- 3. Widen the source CHECK so we can stamp BYO rows with source='user'.
--    The legacy 'free' / 'manual' values stay valid.
ALTER TABLE proxies DROP CONSTRAINT IF EXISTS proxies_source_check;
ALTER TABLE proxies
  ADD CONSTRAINT proxies_source_check
  CHECK (source IN ('free', 'manual', 'user'));

-- 4. Drop the legacy global UNIQUE (host, port, protocol). It blocks
--    two different users from owning the same residential proxy address
--    (a real scenario when a customer adds a public residential pool).
--    Replace with:
--      * uniq_proxies_admin_host_port_protocol   for shared admin rows
--      * uniq_proxies_user_host_port_protocol    for per-user rows
ALTER TABLE proxies DROP CONSTRAINT IF EXISTS proxies_host_port_protocol_key;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_proxies_admin_host_port_protocol
  ON proxies (host, port, protocol)
  WHERE user_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_proxies_user_host_port_protocol
  ON proxies (user_id, host, port, protocol)
  WHERE user_id IS NOT NULL;

-- 5. Helpful indexes for the user-scoped list query.
CREATE INDEX IF NOT EXISTS idx_proxies_user_id ON proxies(user_id);
CREATE INDEX IF NOT EXISTS idx_proxies_user_working
  ON proxies(user_id, is_working) WHERE user_id IS NOT NULL;

-- 6. Cross-table integrity: a session_proxy_assignments row's proxy_id
--    MUST belong either to the session's owner or to the shared admin
--    pool. The trigger raises check_violation otherwise.
CREATE OR REPLACE FUNCTION enforce_session_proxy_ownership() RETURNS trigger AS $$
DECLARE
  v_proxy_owner   INTEGER;
  v_session_owner INTEGER;
BEGIN
  SELECT user_id INTO v_proxy_owner   FROM proxies  WHERE id = NEW.proxy_id;
  SELECT user_id INTO v_session_owner FROM sessions WHERE id = NEW.session_id;

  -- proxy.user_id IS NULL = shared admin pool, allowed for any session.
  IF v_proxy_owner IS NOT NULL AND v_proxy_owner IS DISTINCT FROM v_session_owner THEN
    RAISE EXCEPTION
      'session_proxy_assignment ownership mismatch: proxy.user_id=% session.user_id=%',
       v_proxy_owner, v_session_owner
       USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_session_proxy_ownership ON session_proxy_assignments;
CREATE TRIGGER trg_enforce_session_proxy_ownership
  BEFORE INSERT OR UPDATE ON session_proxy_assignments
  FOR EACH ROW EXECUTE FUNCTION enforce_session_proxy_ownership();

-- 7. Backfill: existing rows stay user_id = NULL (shared admin pool).
--    The __direct__ sentinel row likewise stays NULL — it represents
--    the panel-host VPS IP and is owned by the operator, not any user.
--
--    Phase 1 does NOT migrate any sessions onto user-owned proxies.
--    The audit script at backend/scripts/audit-proxy-ownership.js
--    surfaces existing cross-pool bindings so an operator can plan
--    the Phase 2 cutover.
