import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import app from './src/app.js';
import { testConnection, closePool } from './src/config/db.js';
import { runUp } from './src/migrations/runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '.env') });

const PORT = parseInt(process.env.PORT || '5000', 10);

async function startServer() {
  try {
    // 1. Verify MySQL database connectivity
    await testConnection();

    // 2. Automatically run any pending SQL migrations (essential for Railway / cloud deployments)
    try {
      await runUp();
    } catch (migErr) {
      console.warn('[Migration Warning]: Non-fatal issue running startup migrations:', migErr.message);
    }

    // 3. Bind to 0.0.0.0 for Railway / container reverse proxy compatibility
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log('======================================================');
      console.log(`[Digital Watchdog] Server running on port ${PORT}`);
      console.log(`[Digital Watchdog] Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`[Digital Watchdog] Base API URL: http://localhost:${PORT}/api/v1`);
      console.log(`[Digital Watchdog] Health Check: http://localhost:${PORT}/api/v1/health`);
      console.log('======================================================');
    });

    // Graceful shutdown
    const handleShutdown = async (signal) => {
      console.log(`\n[Shutdown] Received ${signal}. Gracefully shutting down HTTP server...`);
      server.close(async () => {
        try {
          await closePool();
          console.log('[Shutdown] Database connections released. Server terminated cleanly.');
          process.exit(0);
        } catch (err) {
          console.error('[Shutdown Error]:', err);
          process.exit(1);
        }
      });
    };

    process.on('SIGTERM', () => handleShutdown('SIGTERM'));
    process.on('SIGINT', () => handleShutdown('SIGINT'));
  } catch (error) {
    console.error('[Fatal Error] Failed to start Digital Watchdog server:', error.message);
    process.exit(1);
  }
}

startServer();
