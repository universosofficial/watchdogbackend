import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import swaggerUi from 'swagger-ui-express';
import authRoutes from './routes/authRoutes.js';
import businessRoutes from './routes/businessRoutes.js';
import dealRoutes from './routes/dealRoutes.js';
import verificationRoutes from './routes/verificationRoutes.js';
import registryRoutes from './routes/registryRoutes.js';
import enforcementRoutes from './routes/enforcementRoutes.js';
import webhookRoutes from './routes/webhookRoutes.js';
import developerRoutes from './routes/developerRoutes.js';
import whatsappRoutes from './integrations/whatsapp/routes/whatsappRoutes.js';
import telegramRoutes from './integrations/telegram/routes/telegramRoutes.js';
import emailRoutes from './integrations/email/routes/emailRoutes.js';
import { receiveWwsStatusCallback } from './controllers/wwsEscalationController.js';
import { swaggerSpec, swaggerOptions } from './docs/swagger.js';
import { notFoundHandler, globalErrorHandler } from './middleware/errorHandler.js';
import { globalRateLimiter } from './middleware/rateLimiter.js';
import { sendSuccess } from './utils/response.js';
import pool from './config/db.js';

dotenv.config();

const app = express();

// Trust reverse proxy (e.g. Nginx, Cloudflare, AWS ALB) for correct client IP detection
app.set('trust proxy', 1);

// Security Headers
app.use(
  helmet({
    contentSecurityPolicy: false, // Relaxed for Swagger UI docs asset rendering
    crossOriginEmbedderPolicy: false,
    frameguard: { action: 'sameorigin' },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    noSniff: true,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
  })
);

// Cross-Origin Resource Sharing (Strict Whitelisting in Production)
const configuredOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

const allowedOrigins = [
  ...configuredOrigins,
  'https://watchdogfrontend.vercel.app',
  'https://watchdog.univasos.com',
  'https://app.watchdog.univasos.com',
  'https://univaswatchdog.com',
  'https://www.univaswatchdog.com',
  'http://localhost:4200',
  'http://localhost:4300',
  'http://localhost:3000',
  'http://127.0.0.1:4200',
  'http://127.0.0.1:4300',
  'http://127.0.0.1:3000'
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. server-to-server, curl, mobile native webviews)
      if (
        !origin || 
        allowedOrigins.includes(origin) || 
        origin.endsWith('.vercel.app') || 
        origin.endsWith('univasos.com') ||
        origin.endsWith('univaswatchdog.com')
      ) {
        return callback(null, true);
      }
      if (process.env.NODE_ENV === 'production') {
        return callback(new Error('Cross-Origin Request Blocked by Security Policy'));
      }
      console.warn(`[CORS] Allowing non-whitelisted origin in development: ${origin}`);
      return callback(null, true);
    },
    credentials: true
  })
);

// Body Parsers & Cookie Parser
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Global Rate Limiting on API v1
app.use('/api/v1', globalRateLimiter);

// Request Logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (!req.originalUrl.includes('/health')) {
      console.log(`[HTTP] ${req.method} ${req.originalUrl} - ${res.statusCode} (${duration}ms)`);
    }
  });
  next();
});

// Deep Health Check Endpoints
app.get(['/api/health', '/api/v1/health'], async (req, res) => {
  let dbStatus = 'connected';
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    dbStatus = 'disconnected';
    return res.status(503).json({
      success: false,
      service: 'digital-watchdog-api',
      status: 'degraded',
      database: dbStatus,
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }

  return sendSuccess(res, {
    service: 'digital-watchdog-api',
    version: '1.0.0',
    status: 'healthy',
    database: dbStatus,
    storage: process.env.STORAGE_PROVIDER || 'local',
    uptime_seconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// OpenAPI 3.0 Specification & Swagger UI
app.get('/api/v1/docs/swagger.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});
app.use('/api/v1/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, swaggerOptions));

// Mount API v1 Routers
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/businesses', businessRoutes);
app.use('/api/v1/deals', dealRoutes);
app.use('/api/v1/verification', verificationRoutes);
app.use('/api/v1/registry', registryRoutes);
app.use('/api/v1/enforcement', enforcementRoutes);
app.use('/api/v1/webhooks', webhookRoutes);
app.use('/api/v1/developer', developerRoutes);
app.use('/api/v1/integrations/whatsapp', whatsappRoutes);
app.use('/api/v1/integrations/telegram', telegramRoutes);
app.use('/api/v1/integrations/email', emailRoutes);

// WWS Status Update Callback Receiver (HMAC Authenticated)
app.post('/api/v1/integration/wws-status-update', receiveWwsStatusCallback);

// Catch-all for undefined routes
app.use(notFoundHandler);

// Centralized error handling
app.use(globalErrorHandler);

export default app;
