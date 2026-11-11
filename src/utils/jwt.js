import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || 'digital_watchdog_default_jwt_secret_change_in_production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

/**
 * Sign JWT token containing userId, businessId, and role
 * @param {object} payload - { userId, businessId, role, ... }
 * @param {string} [expiresIn]
 * @returns {string} Signed JWT
 */
export function signToken(payload, expiresIn = JWT_EXPIRES_IN) {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn,
    issuer: 'digital-watchdog-auth',
    audience: 'digital-watchdog-client'
  });
}

/**
 * Verify and decode JWT token
 * @param {string} token
 * @returns {object} Decoded payload
 */
export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET, {
    issuer: 'digital-watchdog-auth',
    audience: 'digital-watchdog-client'
  });
}
