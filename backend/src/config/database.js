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
    const schemaPath = path.join(__dirname, 'schema.sql');
    
    if (fs.existsSync(schemaPath)) {
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      console.log('Database schema initialized successfully');
    }
  } catch (error) {
    console.error('Error initializing database schema:', error.message);
  }
};

module.exports = {
  pool,
  initDB,
  query: (text, params) => pool.query(text, params),
};
