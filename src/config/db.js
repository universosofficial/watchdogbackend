import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

// Load environment variables from .env
dotenv.config();

/**
 * Resolves MySQL connection parameters from Railway URLs, Railway individual variables, or local .env variables
 */
export function resolveDatabaseConfig(overrides = {}) {
  const connectionUrl =
    process.env.MYSQL_URL ||
    process.env.DATABASE_URL ||
    process.env.MYSQL_PUBLIC_URL;

  if (connectionUrl) {
    try {
      const parsed = new URL(connectionUrl);
      const urlDbName = parsed.pathname ? parsed.pathname.replace(/^\//, '') : '';
      return {
        host: parsed.hostname || 'localhost',
        port: parseInt(parsed.port || '3306', 10),
        user: decodeURIComponent(parsed.username || 'root'),
        password: decodeURIComponent(parsed.password || ''),
        database: urlDbName || process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE || 'railway',
        waitForConnections: true,
        connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || '10', 10),
        queueLimit: 0,
        decimalNumbers: true,
        multipleStatements: false,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000,
        charset: 'utf8mb4',
        ...overrides
      };
    } catch (err) {
      console.warn('[DB Config] Failed parsing MYSQL_URL/DATABASE_URL, falling back to individual env vars:', err.message);
    }
  }

  const host = process.env.DB_HOST || process.env.MYSQLHOST || process.env.MYSQL_HOST || 'localhost';
  const port = parseInt(process.env.DB_PORT || process.env.MYSQLPORT || process.env.MYSQL_PORT || '3306', 10);
  const user = process.env.DB_USER || process.env.MYSQLUSER || process.env.MYSQL_USER || 'root';
  const password = process.env.DB_PASSWORD ?? process.env.MYSQLPASSWORD ?? process.env.MYSQL_ROOT_PASSWORD ?? '';
  const database =
    process.env.DW_DB_NAME ||
    process.env.MYSQLDATABASE ||
    process.env.MYSQL_DATABASE ||
    (process.env.DB_NAME && !process.env.DB_NAME.includes('world_wide_security') ? process.env.DB_NAME : 'digital_watchdog_db');

  return {
    host,
    port,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || '10', 10),
    queueLimit: 0,
    decimalNumbers: true,
    multipleStatements: false,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    charset: 'utf8mb4',
    ...overrides
  };
}

const dbConfig = resolveDatabaseConfig();

// Create a connection pool to MySQL
export const pool = mysql.createPool(dbConfig);

/**
 * Execute a query with parameters using the connection pool
 * @param {string} sql - SQL query string
 * @param {Array} [params] - Query parameters
 * @returns {Promise<Array>} Query results
 */
export async function query(sql, params = []) {
  try {
    const [rows] = await pool.query(sql, params);
    return rows;
  } catch (error) {
    console.error('[DB Query Error]:', {
      message: error.message,
      code: error.code,
      sqlState: error.sqlState,
      sql: sql.slice(0, 150) + (sql.length > 150 ? '...' : '')
    });
    throw error;
  }
}

/**
 * Obtain a connection from the pool for transactional operations
 * @returns {Promise<mysql.PoolConnection>}
 */
export async function getConnection() {
  return await pool.getConnection();
}

/**
 * Test connectivity to the MySQL database
 * @returns {Promise<boolean>}
 */
export async function testConnection() {
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT 1 AS connected, DATABASE() as `database`, VERSION() as `version`');
    connection.release();
    console.log(`[DB Connected]: Successfully connected to MySQL (${rows[0].version}) on database: ${rows[0].database} (${dbConfig.host}:${dbConfig.port})`);
    return true;
  } catch (error) {
    console.error(`[DB Connection Error]: Failed to connect to MySQL at ${dbConfig.host}:${dbConfig.port} (db: ${dbConfig.database}, user: ${dbConfig.user}):`, error.message);
    throw error;
  }
}

/**
 * Gracefully close the database pool
 */
export async function closePool() {
  try {
    await pool.end();
  } catch {}
}

export default pool;
