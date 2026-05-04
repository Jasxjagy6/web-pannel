-- migration_v16_session_fk_cascade.sql
--
-- Schema-base tables (defined in `schema.sql`) declare their foreign keys to
-- `sessions(id)` WITHOUT `ON DELETE CASCADE`, while the later v2..v13
-- migrations that added more session-linked tables all DO cascade. As soon
-- as a session has any audit/job rows in one of these older tables the
-- DELETE in `sessionService.deleteSession` fails with a foreign-key
-- violation:
--
--   ERROR: update or delete on table "sessions" violates foreign key
--   constraint "scraping_jobs_session_id_fkey" on table "scraping_jobs"
--
-- The UI surfaces this as "Failed to delete session" / "internal server
-- error" — i.e. uploaded sessions can be created and used, but never
-- removed once they've done any work. This migration drops the four
-- legacy NO-ACTION FKs and recreates them as ON DELETE CASCADE, matching
-- the convention of every newer migration.
--
-- Forward-compatible: the cascade behaviour is strictly more permissive
-- than the previous one (rows that referenced a deleted session were
-- already invalid and would have to be cleaned up by hand), so no app code
-- needs to change.
--
-- Tables fixed (all in schema.sql):
--   * scraping_jobs.session_id        → ON DELETE CASCADE
--   * messaging_jobs.session_id       → ON DELETE CASCADE
--   * message_logs.session_id         → ON DELETE SET NULL
--                                       (logs survive session removal so
--                                        history reports keep working)
--   * group_operations.session_id     → ON DELETE CASCADE
--
-- We use `DO $$ ... $$` blocks so re-running the migration on a database
-- that's already been hand-fixed by the operator is a no-op instead of a
-- hard error.

DO $$
DECLARE
  fk_name TEXT;
BEGIN
  -- scraping_jobs.session_id → ON DELETE CASCADE -------------------------
  SELECT conname INTO fk_name
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'scraping_jobs'
     AND c.contype = 'f'
     AND pg_get_constraintdef(c.oid) ILIKE '%REFERENCES sessions%'
   LIMIT 1;
  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE scraping_jobs DROP CONSTRAINT %I', fk_name);
  END IF;
  ALTER TABLE scraping_jobs
    ADD CONSTRAINT scraping_jobs_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

  -- messaging_jobs.session_id → ON DELETE CASCADE ------------------------
  SELECT conname INTO fk_name
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'messaging_jobs'
     AND c.contype = 'f'
     AND pg_get_constraintdef(c.oid) ILIKE '%REFERENCES sessions%'
   LIMIT 1;
  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE messaging_jobs DROP CONSTRAINT %I', fk_name);
  END IF;
  ALTER TABLE messaging_jobs
    ADD CONSTRAINT messaging_jobs_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

  -- message_logs.session_id → ON DELETE SET NULL -------------------------
  -- Logs are a historical artefact; they should outlive the session that
  -- emitted them so per-user reports keep working after a cleanup.
  SELECT conname INTO fk_name
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'message_logs'
     AND c.contype = 'f'
     AND pg_get_constraintdef(c.oid) ILIKE '%REFERENCES sessions%'
   LIMIT 1;
  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE message_logs DROP CONSTRAINT %I', fk_name);
  END IF;
  -- session_id may be NOT NULL on the legacy schema; relax it so SET NULL
  -- on cascade doesn't violate the column constraint.
  ALTER TABLE message_logs ALTER COLUMN session_id DROP NOT NULL;
  ALTER TABLE message_logs
    ADD CONSTRAINT message_logs_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL;

  -- group_operations.session_id → ON DELETE CASCADE ----------------------
  SELECT conname INTO fk_name
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'group_operations'
     AND c.contype = 'f'
     AND pg_get_constraintdef(c.oid) ILIKE '%REFERENCES sessions%'
   LIMIT 1;
  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE group_operations DROP CONSTRAINT %I', fk_name);
  END IF;
  ALTER TABLE group_operations
    ADD CONSTRAINT group_operations_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;
END $$;
