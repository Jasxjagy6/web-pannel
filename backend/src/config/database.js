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

const ensureAdminUser = async () => {
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@example.com').trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const passwordHash = await bcrypt.hash(adminPassword, 10);

  // Insert if missing, then re-hash the password and force admin/approved
  // status on every boot (so changing ADMIN_PASSWORD in .env actually
  // takes effect, and so an accidental DB UPDATE can't lock the admin
  // out of their own panel).
  await pool.query(
    `INSERT INTO users (email, password_hash, role, status, is_approved,
                        approved_at, subscription_status, subscription_plan,
                        subscription_features, created_at, updated_at)
     VALUES ($1, $2, 'admin', 'approved', TRUE, NOW(),
             'active', 'admin', '{"all":true}'::jsonb, NOW(), NOW())
     ON CONFLICT (email) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       role = 'admin',
       status = 'approved',
       is_approved = TRUE,
       approved_at = COALESCE(users.approved_at, NOW()),
       subscription_status = 'active',
       subscription_plan = COALESCE(users.subscription_plan, 'admin'),
       subscription_features = COALESCE(users.subscription_features, '{}'::jsonb) || '{"all":true}'::jsonb,
       updated_at = NOW()`,
    [adminEmail, passwordHash]
  );
  console.log(`Admin user ensured: ${adminEmail}`);
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
