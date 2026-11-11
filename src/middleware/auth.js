import { verifyToken } from '../utils/jwt.js';
import { sendError } from '../utils/response.js';
import { AUTH_COOKIE_NAME } from '../utils/cookieHelper.js';
import pool from '../config/db.js';
import ApiKeyService from '../services/apiKeyService.js';

/**
 * Authentication Middleware: Verifies HttpOnly Cookie, Bearer JWT token, or B2B API Key
 */
export async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    const xApiKey = req.headers['x-api-key'];
    let token = null;

    if (xApiKey) {
      token = xApiKey;
    } else if (req.cookies && req.cookies[AUTH_COOKIE_NAME]) {
      token = req.cookies[AUTH_COOKIE_NAME];
    } else if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    } else if (req.query && req.query.token) {
      token = req.query.token;
    }

    if (!token) {
      return sendError(
        res,
        'Authorization token is missing. Please sign in or provide an API Key.',
        'UNAUTHORIZED',
        401
      );
    }

    // Check if token is a B2B Developer API Key (e.g. dw_live_sec_... or dw_test_sec_...)
    if (token.startsWith('dw_live_sec_') || token.startsWith('dw_test_sec_')) {
      const apiKeyAuth = await ApiKeyService.authenticateApiKey(token);
      if (!apiKeyAuth) {
        return sendError(res, 'Invalid or revoked API Key.', 'INVALID_API_KEY', 401);
      }

      req.user = { id: apiKeyAuth.userId, full_name: apiKeyAuth.businessName, active_persona: 'seller' };
      req.userId = apiKeyAuth.userId;
      req.businessId = apiKeyAuth.businessId;
      req.role = apiKeyAuth.role;
      req.persona = 'seller';
      req.apiKey = apiKeyAuth;
      return next();
    }

    let decoded;
    try {
      decoded = verifyToken(token);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return sendError(res, 'Authentication token has expired', 'TOKEN_EXPIRED', 401);
      }
      return sendError(res, 'Invalid authentication token', 'TOKEN_INVALID', 401);
    }

    // Verify user exists and is active in database
    const [users] = await pool.query(
      'SELECT id, email, full_name, phone, active_persona, country_code, default_currency, is_id_verified, kyc_tier FROM users WHERE id = ?',
      [decoded.userId]
    );

    if (users.length === 0) {
      return sendError(res, 'User record associated with this token does not exist', 'USER_NOT_FOUND', 401);
    }

    // Attach contextual information to the request
    req.user = users[0];
    req.userId = decoded.userId;
    req.businessId = decoded.businessId || null;
    req.role = decoded.role || null;
    req.persona = decoded.persona || users[0].active_persona || 'buyer';

    next();
  } catch (error) {
    console.error('[Auth Middleware Error]:', error);
    return sendError(res, 'Internal authentication error', 'INTERNAL_ERROR', 500);
  }
}

/**
 * Ensures user has an active business context
 */
export function requireBusiness(req, res, next) {
  if (!req.businessId) {
    return sendError(
      res,
      'Active business context required. Please onboard or select a business context.',
      'NO_BUSINESS_CONTEXT',
      400
    );
  }
  next();
}

/**
 * Role-Based Access Control (RBAC) middleware
 * @param  {...string} roles - e.g. 'owner', 'staff'
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.role || !roles.includes(req.role)) {
      return sendError(
        res,
        `Access denied. Requires one of the following roles: [${roles.join(', ')}]`,
        'FORBIDDEN',
        403
      );
    }
    next();
  };
}
