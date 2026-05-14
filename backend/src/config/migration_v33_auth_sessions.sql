-- Migration v33: session tracking + blanket revocation.
--
-- Why: rotating ADMIN_EMAIL / ADMIN_PASSWORD in backend/.env used to
-- silently keep every currently-open browser logged in, because JWTs
-- are stateless and the boot path didn't have a way to invalidate
-- them. This migration introduces two new pieces of state:
--
--   1. users.tokens_invalidated_at — a per-user "every JWT issued
--      before this instant is invalid" timestamp. ensureAdminUser()
--      sets it whenever the env email or password changes, and the
--      auth middleware compares each JWT's `iat` against it.
--
--   2. auth_sessions — one row per currently-open browser. The login
--      controller inserts a row (with a random jti embedded in the
--      JWT) so we can:
--        - mass-revoke them on env rotation (set revoked_at);
--        - list them in the admin panel ("active logins for this
--          user") with IP / user-agent / last-seen info;
--        - revoke them individually from the admin panel.
--
-- Both surfaces are additive: pre-existing JWTs without a jti claim
-- still work, but they fail the iat-vs-tokens_invalidated_at check
-- after the next env rotation, which is exactly what the user wants.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS tokens_invalidated_at TIMESTAMPTZ;

COMMENT ON COLUMN users.tokens_invalidated_at
  IS 'Set to NOW() whenever every active JWT for this user must be '
     'rejected (e.g. ADMIN_EMAIL/ADMIN_PASSWORD rotation, admin force '
     'logout). Auth middleware rejects any JWT with iat < this value.';

CREATE TABLE IF NOT EXISTS auth_sessions (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  jti           UUID NOT NULL UNIQUE,
  ip_address    VARCHAR(64),
  user_agent    TEXT,
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  revoked_reason VARCHAR(64)
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user
  ON auth_sessions(user_id);

-- Partial index: we only ever look up *active* sessions by jti from the
-- auth middleware hot path. Revoked rows stay around for the admin UI
-- (audit log of past logins) but don't need to be in this index.
CREATE INDEX IF NOT EXISTS idx_auth_sessions_active_jti
  ON auth_sessions(jti)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_active
  ON auth_sessions(user_id, last_seen_at DESC)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE auth_sessions
  IS 'One row per JWT issued by /api/auth/login (and /register, /refresh). '
     'jti is embedded in the JWT and looked up on every authenticated '
     'request to support per-session revocation and the admin "active '
     'logins" view.';
