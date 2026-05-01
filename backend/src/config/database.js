const { Pool } = require('pg');
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

    // Ensure the single admin user (id=1) exists so that foreign-key
    // references from sessions / activity_logs / lists / reports stay valid.
    // The auth controller signs JWTs with userId=1; without a matching row
    // every insert that references user_id would fail with a FK violation
    // (the cause of the 500s seen on /api/dashboard/stats and
    // /api/sessions/upload in production).
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
    await pool.query(
      `INSERT INTO users (id, email, password_hash, role, created_at)
       VALUES (1, $1, '__env_managed__', 'admin', NOW())
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
      [adminEmail]
    );
    // Bump the SERIAL sequence so future inserts (if any) start at id=2.
    await pool.query(
      `SELECT setval(
         pg_get_serial_sequence('users', 'id'),
         GREATEST((SELECT COALESCE(MAX(id), 1) FROM users), 1)
       )`
    );
    console.log('Admin user ensured (id=1)');
  } catch (error) {
    console.error('Error initializing database schema:', error.message);
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
