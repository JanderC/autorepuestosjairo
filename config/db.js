const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // necesario para Neon
});

pool.on('connect', () => {
  console.log('Conectado a la base de datos PostgreSQL (Neon)');
});

module.exports = pool;