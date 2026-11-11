import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import app from './src/app.js';
import { testConnection, closePool } from './src/config/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '.env') });

const PORT = parseInt(process.env.PORT || '5000', 10);

async function startServer() {
  try {
    // Verify MySQL database connectivity before accepting connections
    await testConnection();

    const server = app.listen(PORT, () => {
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
