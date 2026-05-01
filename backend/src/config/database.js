const { Pool } = require('pg');
const bcrypt = require('bcrypt');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'telegram_panel',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'your_secure_password',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

const initDB = async () => {
  try {
    const fs = require('fs');
    const path = require('path');

    // Apply base schema first.
    const schemaPath = path.join(__dirname, 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('Database schema initialized successfully');
    }

    // Apply additive migrations in order. Each migration is idempotent.
    const migrations = [
      'migration_scraping_upgrade.sql',
      'migration_v2_upgrades.sql',
      'migration_group_operations_ownership.sql',
      'migration_v3_antidetect.sql',
      'migration_v4_privacy.sql',
      'migration_v5_multiuser.sql',
      'migration_v6_scrape_monitor.sql',
    ];
    for (const m of migrations) {
      const mPath = path.join(__dirname, m);
      if (!fs.existsSync(mPath)) continue;
      try {
        const sql = fs.readFileSync(mPath, 'utf8');
        await pool.query(sql);
        console.log(`Applied migration: ${m}`);
      } catch (err) {
        console.error(`Failed migration ${m}:`, err.message);
      }
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
