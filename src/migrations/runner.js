import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { resolveDatabaseConfig } from '../config/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
const SQL_DIR = path.join(__dirname, 'sql');

const dbConfig = resolveDatabaseConfig({ multipleStatements: true });

/**
 * Ensures the target database exists on the MySQL server
 */
async function ensureDatabaseExists() {
  const connection = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    multipleStatements: true
  });

  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
    );
    console.log(`[Migration Runner] Database verified/created: "${dbConfig.database}"`);
  } catch (err) {
    // Managed cloud MySQL instances (e.g. Railway) pre-create the default database and may restrict CREATE DATABASE
    console.log(`[Migration Runner] Using pre-provisioned database: "${dbConfig.database}"`);
  } finally {
    await connection.end();
  }
}

/**
 * Ensures the schema_migrations tracking table exists
 */
async function ensureMigrationsTable(conn) {
  const createTableSql = `
    CREATE TABLE IF NOT EXISTS \`schema_migrations\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`migration_name\` VARCHAR(255) NOT NULL UNIQUE,
      \`applied_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;
  await conn.query(createTableSql);
}

/**
 * Retrieves applied migrations from the tracking table
 */
async function getAppliedMigrations(conn) {
  const [rows] = await conn.query('SELECT migration_name FROM `schema_migrations` ORDER BY id ASC');
  return new Set(rows.map(r => r.migration_name));
}

/**
 * Runs pending migrations ('up' action)
 */
export async function runUp() {
  await ensureDatabaseExists();

  const conn = await mysql.createConnection(dbConfig);
  try {
    await ensureMigrationsTable(conn);
    const applied = await getAppliedMigrations(conn);

    if (!fs.existsSync(SQL_DIR)) {
      console.warn(`[Migration Runner] No SQL directory found at ${SQL_DIR}`);
      return;
    }

    const files = fs.readdirSync(SQL_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();

    const pending = files.filter(f => !applied.has(f));

    if (pending.length === 0) {
      console.log('[Migration Runner] Database schema is up to date. No pending migrations.');
      return;
    }

    console.log(`[Migration Runner] Found ${pending.length} pending migration(s): ${pending.join(', ')}`);

    for (const file of pending) {
      const filePath = path.join(SQL_DIR, file);
      const sqlContent = fs.readFileSync(filePath, 'utf-8');

      console.log(`[Migration Runner] Applying migration: ${file}...`);
      const startTime = Date.now();

      try {
        await conn.query(sqlContent);
        await conn.query('INSERT IGNORE INTO `schema_migrations` (`migration_name`) VALUES (?)', [file]);
        const duration = Date.now() - startTime;
        console.log(`[Migration Runner] Successfully applied ${file} in ${duration}ms.`);
      } catch (err) {
        if (err.code === 'ER_DUP_FIELDNAME' || err.code === 'ER_TABLE_EXISTS_ERROR' || err.code === 'ER_DUP_KEYNAME') {
          console.log(`[Migration Runner] Schema changes in ${file} already exist (${err.code}). Marking as applied.`);
          await conn.query('INSERT IGNORE INTO `schema_migrations` (`migration_name`) VALUES (?)', [file]);
        } else {
          console.error(`[Migration Runner] Failed executing migration ${file}:`, err.message);
          throw err;
        }
      }
    }

    console.log('[Migration Runner] All migrations executed successfully.');
  } finally {
    await conn.end();
  }
}

/**
 * Drops and recreates database tables ('reset' action)
 */
async function runReset() {
  console.log(`[Migration Runner] Resetting database "${dbConfig.database}"...`);
  const connection = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    multipleStatements: true
  });

  try {
    await connection.query(`DROP DATABASE IF EXISTS \`${dbConfig.database}\`;`);
    await connection.query(
      `CREATE DATABASE \`${dbConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
    );
    console.log(`[Migration Runner] Database "${dbConfig.database}" reset cleanly.`);
  } finally {
    await connection.end();
  }

  await runUp();
}

/**
 * Shows migration status
 */
async function showStatus() {
  await ensureDatabaseExists();
  const conn = await mysql.createConnection(dbConfig);
  try {
    await ensureMigrationsTable(conn);
    const applied = await getAppliedMigrations(conn);

    const files = fs.readdirSync(SQL_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();

    console.log('\n--- Migration Status ---');
    for (const file of files) {
      const isApplied = applied.has(file);
      console.log(`[${isApplied ? 'APPLIED' : 'PENDING'}] ${file}`);
    }
    console.log('------------------------\n');
  } finally {
    await conn.end();
  }
}

// CLI Command dispatch only when executed directly
const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectExecution) {
  const command = process.argv[2] || 'up';
  (async () => {
    try {
      switch (command) {
        case 'up':
          await runUp();
          break;
        case 'reset':
          await runReset();
          break;
        case 'status':
          await showStatus();
          break;
        default:
          console.error(`Unknown command: "${command}". Available commands: up, reset, status.`);
          process.exit(1);
      }
      process.exit(0);
    } catch (err) {
      console.error('[Migration Runner Error]:', err);
      process.exit(1);
    }
  })();
}
