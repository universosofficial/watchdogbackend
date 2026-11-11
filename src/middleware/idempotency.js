import crypto from 'crypto';
import pool from '../config/db.js';
import { sendError } from '../utils/response.js';

const IDEMPOTENCY_TTL_HOURS = 24;

/**
 * Idempotency Middleware: Prevents double-spend and duplicate state transitions.
 * 
 * Inspects `X-Idempotency-Key` header. If an operation was already processed
 * with this key, the identical cached response is returned without re-executing logic.
 */
export function idempotency({ required = false } = {}) {
  return async (req, res, next) => {
    // Only apply to state-mutating HTTP methods
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      return next();
    }

    const idempotencyKey = req.headers['x-idempotency-key'] || req.headers['idempotency-key'];

    if (!idempotencyKey) {
      if (required) {
        return sendError(
          res,
          'X-Idempotency-Key header is mandatory for this financial or contract operation.',
          'IDEMPOTENCY_KEY_REQUIRED',
          400
        );
      }
      return next();
    }

    // Key format validation
    const cleanKey = String(idempotencyKey).trim();
    if (cleanKey.length < 8 || cleanKey.length > 64) {
      return sendError(
        res,
        'Invalid X-Idempotency-Key length. Expected between 8 and 64 characters.',
        'INVALID_IDEMPOTENCY_KEY',
        400
      );
    }

    const userId = req.userId || 'anonymous';
    const endpoint = `${req.method} ${req.baseUrl}${req.path}`;
    const payloadString = JSON.stringify(req.body || {});
    const requestHash = crypto.createHash('sha256').update(`${userId}|${endpoint}|${payloadString}`).digest('hex');

    try {
      // 1. Check if key already processed
      const [rows] = await pool.query(
        'SELECT response_status, response_body, request_hash, expires_at FROM idempotency_keys WHERE key_id = ?',
        [cleanKey]
      );

      if (rows.length > 0) {
        const cached = rows[0];

        // Ensure key wasn't reused for a completely different payload
        if (cached.request_hash !== requestHash) {
          return sendError(
            res,
            'Idempotency key collision: This key was previously used with a different request payload.',
            'IDEMPOTENCY_KEY_CONFLICT',
            409
          );
        }

        // Return cached response
        res.setHeader('X-Cache-Lookup', 'HIT-IDEMPOTENT');
        let parsedBody;
        try {
          parsedBody = JSON.parse(cached.response_body);
        } catch {
          parsedBody = cached.response_body;
        }

        return res.status(cached.response_status).json(parsedBody);
      }

      // 2. Intercept response to record into database upon completion
      const originalJson = res.json.bind(res);
      res.json = function (body) {
        const statusCode = res.statusCode || 200;

        // Only cache successful or legitimate client business errors (avoid caching 500 crashes)
        if (statusCode < 500) {
          const bodyToStore = JSON.stringify(body);
          const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000);

          pool.query(
            `INSERT INTO idempotency_keys (key_id, user_id, endpoint, request_hash, response_status, response_body, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE response_status = VALUES(response_status), response_body = VALUES(response_body)`,
            [cleanKey, userId === 'anonymous' ? null : userId, endpoint, requestHash, statusCode, bodyToStore, expiresAt]
          ).catch(err => {
            console.warn('[Idempotency Cache Warning]:', err.message);
          });
        }

        res.setHeader('X-Idempotency-Key-Status', 'RECORDED');
        return originalJson(body);
      };

      next();
    } catch (err) {
      console.error('[Idempotency Middleware Error]:', err);
      // In case of cache lookup failure, gracefully fail open rather than breaking the app
      next();
    }
  };
}
