import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

// Load environment variables from .env
dotenv.config();

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DW_DB_NAME || (process.env.DB_NAME && !process.env.DB_NAME.includes('world_wide_security') ? process.env.DB_NAME : 'digital_watchdog_db'),
  waitForConnections: true,
  connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || '10', 10),
  queueLimit: 0,
  decimalNumbers: true,
  multipleStatements: false,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  charset: 'utf8mb4'
};

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
    const [rows, fields] = await pool.query(sql, params);
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
    console.log(`[DB Connected]: Successfully connected to MySQL (${rows[0].version}) on database: ${rows[0].database}`);
    return true;
  } catch (error) {
    console.error('[DB Connection Error]: Failed to connect to MySQL database:', error.message);
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
