const { Pool } = require('pg');
const bcrypt = require('bcrypt');
require('dotenv').config();

const migrations = require('./migrations');

// Pool sized for the 500-700 concurrent user target. With ~50 conns
// per panel pod and ~150 max connections in Postgres, three panel
// pods saturates the DB; tune `DB_POOL_MAX` per pod accordingly. See
// OPS.md for the full scale-up procedure.
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5435'),
  database: process.env.DB_NAME || 'telegram_panel',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'your_secure_password',
  max: parseInt(process.env.DB_POOL_MAX || '50'),
  idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_MS || '30000'),
  connectionTimeoutMillis: parseInt(process.env.DB_POOL_CONNECT_MS || '5000'),
  // Rotate every 10 minutes so a long-lived pod never builds up too
  // many half-dead connections.
  maxLifetimeSeconds: parseInt(process.env.DB_POOL_LIFETIME_SEC || '600'),
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

const initDB = async () => {
  try {
    // Apply base schema (idempotent, uses CREATE TABLE IF NOT EXISTS).
    await migrations.applySchemaSql(pool);

    // First contact with a database that pre-dates the migration runner:
    // record every existing migration_*.sql as already applied so we don't
    // try to re-run them. No-op on a fresh DB or on subsequent boots.
    await migrations.seedHistoryIfPreExisting(pool);

    // Apply any pending migrations. Each runs in its own transaction.
    // The orchestrator (`bin/upgrade`) also calls this path before flipping
    // traffic, so on a normal deploy this loop is a no-op at boot time.
    if (process.env.SKIP_BOOT_MIGRATIONS !== 'true') {
      try {
        await migrations.applyPending(pool);
      } catch (err) {
        // We deliberately don't throw — keeping the legacy boot semantics
        // (the panel still comes up so the operator can investigate). The
        // CLI / orchestrator path is strict and will refuse to flip traffic
        // if migrations fail.
        console.error('Migration apply failed at boot:', err.message);
      }
    } else {
      console.log('SKIP_BOOT_MIGRATIONS=true — skipping in-process migration apply.');
    }

    await ensureGroupOperationsSchema();

    // Bootstrap the admin user from .env (ADMIN_EMAIL / ADMIN_PASSWORD).
    // Stored with a bcrypt hash so the regular login flow works for the
    // admin too — there is no special-case "env shortcut" in the JWT
    // anymore, every authenticated request resolves to a real users row.
    await ensureAdminUser();
    // Bump the SERIAL sequence so future inserts start past whatever
    // id the admin row landed on.
    await pool.query(
      `SELECT setval(
         pg_get_serial_sequence('users', 'id'),
         GREATEST((SELECT COALESCE(MAX(id), 1) FROM users), 1)
       )`
    );
  } catch (error) {
    console.error('Error initializing database schema:', error.message);
  }
};

/**
 * Bootstrap / reconcile the env-managed admin user.
 *
 * The legacy implementation used `INSERT ... ON CONFLICT (email) DO UPDATE`,
 * which keyed the conflict on the *current* email — so rotating ADMIN_EMAIL
 * in backend/.env inserted a brand-new admin row each time and left the old
 * one (e.g. admin@example.com) sitting in the database with its old
 * password still valid. See migration_v32_env_admin_marker.sql for the
 * column / backfill that powers this rewrite.
 *
 * The contract this function honors:
 *   - At most one user row has is_env_admin = TRUE. That row's email and
 *     password_hash always reflect ADMIN_EMAIL / ADMIN_PASSWORD from .env.
 *   - When the env values change, the SAME row is updated in place, so its
 *     id and all foreign-key-referencing data (sessions, jobs, lists,
 *     billing rows, etc.) survive, and any JWT issued before the rotation
 *     keeps working (auth middleware re-loads the row by userId, not email).
 *   - The old credentials (old email and/or password) stop working
 *     immediately after the next boot. If the legacy buggy path already
 *     inserted a phantom row at the new env email, it gets quarantined
 *     here so it can't be used to log in either.
 */
const ensureAdminUser = async () => {
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@example.com').trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const passwordHash = await bcrypt.hash(adminPassword, 10);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const envAdminRes = await client.query(
      `SELECT id, LOWER(email) AS email
         FROM users
        WHERE is_env_admin = TRUE
        LIMIT 1`
    );
    const envAdmin = envAdminRes.rows[0];

    if (envAdmin) {
      if (envAdmin.email !== adminEmail) {
        // Email rotation requested. Resolve any collision on UNIQUE(email)
        // before renaming the env-admin row. The only path that could put
        // another row at this email is the legacy buggy seed (no other
        // code path creates admin rows from the env email). Quarantine the
        // duplicate so its credentials stop working, but keep the row so
        // any data referencing it remains recoverable.
        const dupRes = await client.query(
          `SELECT id FROM users
            WHERE LOWER(email) = $1 AND id <> $2
            LIMIT 1`,
          [adminEmail, envAdmin.id]
        );
        const dup = dupRes.rows[0];
        if (dup) {
          await client.query(
            `UPDATE users
                SET email = 'legacy-admin-' || id || '@invalid.local',
                    role = 'user',
                    status = 'pending',
                    is_approved = FALSE,
                    approved_at = NULL,
                    is_env_admin = FALSE,
                    updated_at = NOW()
              WHERE id = $1`,
            [dup.id]
          );
          console.warn(
            `Admin bootstrap: quarantined duplicate user id=${dup.id} that ` +
            `collided with new ADMIN_EMAIL=${adminEmail}. The original env-admin ` +
            `row (id=${envAdmin.id}) is being renamed to ${adminEmail}; its ` +
            `data and sessions are preserved.`
          );
        }
      }

      // Update the existing env-admin row in place. Email change (if any)
      // and password are applied to the SAME row id, so foreign-key data
      // (sessions, jobs, lists, etc.) and any active JWTs continue to
      // resolve to this user.
      await client.query(
        `UPDATE users
            SET email = $1,
                password_hash = $2,
                role = 'admin',
                status = 'approved',
                is_approved = TRUE,
                approved_at = COALESCE(approved_at, NOW()),
                subscription_status = 'active',
                subscription_plan = COALESCE(subscription_plan, 'admin'),
                subscription_features = COALESCE(subscription_features, '{}'::jsonb)
                                       || '{"all":true}'::jsonb,
                banned_at = NULL,
                banned_reason = NULL,
                updated_at = NOW()
          WHERE id = $3`,
        [adminEmail, passwordHash, envAdmin.id]
      );
      if (envAdmin.email !== adminEmail) {
        console.log(
          `Admin user ensured (id=${envAdmin.id}): renamed ${envAdmin.email} -> ${adminEmail}`
        );
      } else {
        console.log(`Admin user ensured (id=${envAdmin.id}): ${adminEmail}`);
      }
    } else {
      // No env-managed admin yet. Either the database is fresh, or the v32
      // migration's backfill found no existing admin rows. Promote any
      // existing user that happens to already use the env email, otherwise
      // insert a new admin row.
      const existingRes = await client.query(
        `SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1`,
        [adminEmail]
      );
      const existing = existingRes.rows[0];
      if (existing) {
        await client.query(
          `UPDATE users
              SET password_hash = $1,
                  role = 'admin',
                  status = 'approved',
                  is_approved = TRUE,
                  approved_at = COALESCE(approved_at, NOW()),
                  subscription_status = 'active',
                  subscription_plan = COALESCE(subscription_plan, 'admin'),
                  subscription_features = COALESCE(subscription_features, '{}'::jsonb)
                                         || '{"all":true}'::jsonb,
                  is_env_admin = TRUE,
                  banned_at = NULL,
                  banned_reason = NULL,
                  updated_at = NOW()
            WHERE id = $2`,
          [passwordHash, existing.id]
        );
        console.log(
          `Admin user ensured (id=${existing.id}): ${adminEmail} ` +
          `(promoted existing user to env-admin)`
        );
      } else {
        const insertRes = await client.query(
          `INSERT INTO users (email, password_hash, role, status, is_approved,
                              approved_at, subscription_status, subscription_plan,
                              subscription_features, is_env_admin,
                              created_at, updated_at)
           VALUES ($1, $2, 'admin', 'approved', TRUE, NOW(),
                   'active', 'admin', '{"all":true}'::jsonb, TRUE,
                   NOW(), NOW())
           RETURNING id`,
          [adminEmail, passwordHash]
        );
        console.log(
          `Admin user ensured (id=${insertRes.rows[0].id}): ${adminEmail} (created)`
        );
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

const ensureGroupOperationsSchema = async () => {
  await pool.query(`
    ALTER TABLE group_operations
      ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id),
      ADD COLUMN IF NOT EXISTS operation_type VARCHAR(50),
      ADD COLUMN IF NOT EXISTS total_users INTEGER,
      ADD COLUMN IF NOT EXISTS options JSONB
  `);

  await pool.query(`
    UPDATE group_operations go
    SET user_id = s.user_id
    FROM sessions s
    WHERE go.user_id IS NULL
      AND go.session_id = s.id
  `);

  await pool.query(`
    UPDATE group_operations
    SET operation_type = operation
    WHERE operation_type IS NULL
      AND operation IS NOT NULL
  `);

  await pool.query(`
    UPDATE group_operations
    SET total_users = total_count
    WHERE total_users IS NULL
      AND total_count IS NOT NULL
  `);

  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_group_operations_user_id ON group_operations(user_id)'
  );

  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_group_operations_user_created ON group_operations(user_id, created_at DESC)'
  );
};

module.exports = {
  pool,
  initDB,
  query: (text, params) => pool.query(text, params),
};
