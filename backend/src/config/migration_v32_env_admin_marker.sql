-- Migration v32: env-admin marker.
--
-- Historically the boot path seeded the admin via
--   INSERT INTO users (...) VALUES (env_email, ...) ON CONFLICT (email) DO UPDATE ...
-- which means the conflict was keyed on the *current* email. Rotating
-- ADMIN_EMAIL in backend/.env therefore inserted a brand-new admin row each
-- time, instead of renaming the existing one. The previous admin row stayed
-- in place, role='admin' and its old password still valid — so the original
-- admin@example.com / admin123 credentials could be used to log in
-- indefinitely.
--
-- This migration introduces a single source of truth — `is_env_admin` —
-- so the boot path can find and update the same admin row regardless of
-- which email it is currently configured with. It also retires any
-- legacy admin rows that were left behind by the buggy bootstrap path so
-- those old credentials stop working at the next boot.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_env_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- Enforce at most one env-managed admin at the SQL level. Partial unique
-- index so the column itself can stay BOOLEAN (FALSE on every regular user).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_env_admin_singleton
  ON users (is_env_admin)
  WHERE is_env_admin = TRUE;

-- Backfill: mark the oldest existing admin (lowest id) as THE env admin.
-- On a fresh database this is a no-op; the boot path will insert the env
-- admin afterwards.
UPDATE users
   SET is_env_admin = TRUE,
       updated_at = NOW()
 WHERE id = (
   SELECT id FROM users
    WHERE role = 'admin'
    ORDER BY id ASC
    LIMIT 1
 );

-- Quarantine any leftover admin rows from previous buggy boots. The row is
-- preserved (so any FK-referencing data attached to it survives) but the
-- email is renamed to an .invalid.local sentinel so the old login form
-- can no longer find it, and the role/approval is reset so even a stale
-- JWT pointing at this row cannot hit admin-only routes.
--
-- NOTE: this is intentionally one-shot. The boot path performs the same
-- quarantine for any *future* collisions when ADMIN_EMAIL is rotated, but
-- the migration cleans up history so a single deploy of this fix retires
-- every stale admin@example.com-style row that already exists.
UPDATE users
   SET email = 'legacy-admin-' || id || '@invalid.local',
       role = 'user',
       status = 'pending',
       is_approved = FALSE,
       approved_at = NULL,
       updated_at = NOW()
 WHERE role = 'admin'
   AND is_env_admin = FALSE;

COMMENT ON COLUMN users.is_env_admin
  IS 'TRUE for the single admin row managed by ADMIN_EMAIL / ADMIN_PASSWORD '
     'in backend/.env. Used by ensureAdminUser() at boot to update the same '
     'row in place when the env values change, instead of inserting a new '
     'admin every time.';
