const { Pool } = require('pg');
const { AppError } = require('./errors');
const { postgresTls } = require('./postgres-tls');
const { postgresTypes } = require('./postgres-store');
const { UTC_NOW, isoInstant, utcInstant } = require('./postgres-time');

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.user_id,
    name: row.full_name,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    active: row.is_active,
    createdAt: isoInstant(row.created_at)
  };
}

let pool = null;

function getPool(config) {
  if (!pool) {
    const databaseUrl = config.databaseUrl;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    
    pool = new Pool({
      connectionString: databaseUrl,
      ssl: postgresTls(config),
      types: postgresTypes,
      max: 2,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    pool.on('error', (err) => {
      console.error('Unexpected pool error:', err);
    });
  }
  return pool;
}

function createPostgresAuthStore(config, dependencies = {}) {
  const db = dependencies.pool || getPool(config);

  async function query(sql, values = []) {
    try {
      const result = await db.query(sql, values);
      return result.rows;
    } catch (error) {
      throw new AppError(503, 'DATABASE_UNAVAILABLE', 'The MEDRIPPLE database is unavailable. Check the PostgreSQL connection and run the database seed.', { databaseCode: error.code });
    }
  }

  return {
    source: 'POSTGRES',
    async findByEmail(email) {
      const rows = await query(
        `SELECT user_id, full_name, email, password_hash, role, is_active, ${utcInstant('created_at')} AS created_at
         FROM app_users WHERE email = $1 LIMIT 1`,
        [email]
      );
      return mapUser(rows[0]);
    },
    async create(user) {
      try {
        await db.query(
          `INSERT INTO app_users (user_id, full_name, email, password_hash, role, is_active, created_at)
           VALUES ($1, $2, $3, $4, $5, TRUE, ${UTC_NOW})`,
          [user.id, user.name, user.email, user.passwordHash, user.role]
        );
      } catch (error) {
        if (error.code === '23505') { // PostgreSQL unique violation
          throw new AppError(409, 'ACCOUNT_EXISTS', 'An account already exists for this email address.');
        }
        throw new AppError(503, 'DATABASE_UNAVAILABLE', 'The MEDRIPPLE database could not create the account.', { databaseCode: error.code });
      }
      return user;
    },
    async recordLogin(userId) {
      await query(`UPDATE app_users SET last_login_at = ${UTC_NOW} WHERE user_id = $1`, [userId]);
    },
    async close() {
      if (pool) {
        await pool.end();
        pool = null;
      }
    }
  };
}

module.exports = { createPostgresAuthStore, mapUser };
