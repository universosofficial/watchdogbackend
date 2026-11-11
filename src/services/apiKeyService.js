import crypto from 'crypto';
import pool from '../config/db.js';
import { AppError } from '../utils/response.js';

export class ApiKeyService {
  /**
   * Generates a new cryptographically secure API Key
   */
  static async generateApiKey({
    businessId,
    userId,
    name = 'Production API Key',
    environment = 'live',
    scopes = ['deals:read', 'deals:write', 'trust_radar:read', 'webhooks:manage']
  }) {
    if (!businessId) {
      throw new AppError('Business ID is required to generate API Key', 400, 'MISSING_BUSINESS');
    }

    if (!['live', 'test'].includes(environment)) {
      throw new AppError("Environment must be either 'live' or 'test'", 400, 'INVALID_ENV');
    }

    const keyId = crypto.randomUUID();
    const entropy = crypto.randomBytes(24).toString('hex');
    const rawKey = `dw_${environment}_sec_${entropy}`;
    
    // Store only SHA-256 hash of secret key
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const displayPrefix = `dw_${environment}_sec_${entropy.substring(0, 4)}...${entropy.slice(-4)}`;

    await pool.query(
      `INSERT INTO api_keys (
        id, business_id, user_id, name, key_prefix, key_hash,
        environment, scopes_json, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE, NOW(), NOW())`,
      [
        keyId,
        businessId,
        userId,
        name.trim() || 'API Key',
        displayPrefix,
        keyHash,
        environment,
        JSON.stringify(scopes)
      ]
    );

    return {
      id: keyId,
      name: name.trim() || 'API Key',
      environment,
      key_prefix: displayPrefix,
      api_key: rawKey, // ONLY RETURNED ONCE!
      scopes,
      created_at: new Date().toISOString()
    };
  }

  /**
   * List all API keys for a business (masked, never exposing raw secret)
   */
  static async listApiKeys(businessId) {
    const [rows] = await pool.query(
      `SELECT 
        k.id, k.name, k.key_prefix, k.environment, k.scopes_json,
        k.last_used_at, k.is_active, k.created_at,
        u.full_name AS created_by_name
       FROM api_keys k
       LEFT JOIN users u ON k.user_id = u.id
       WHERE k.business_id = ?
       ORDER BY k.created_at DESC`,
      [businessId]
    );

    return rows.map(r => ({
      ...r,
      scopes: typeof r.scopes_json === 'string' ? JSON.parse(r.scopes_json) : (r.scopes_json || []),
      scopes_json: undefined
    }));
  }

  /**
   * Revoke (deactivate) an API key
   */
  static async revokeApiKey(keyId, businessId) {
    const [res] = await pool.query(
      'UPDATE api_keys SET is_active = FALSE, updated_at = NOW() WHERE id = ? AND business_id = ?',
      [keyId, businessId]
    );

    if (res.affectedRows === 0) {
      throw new AppError('API key not found or not authorized', 404, 'KEY_NOT_FOUND');
    }

    return { success: true, message: 'API key successfully revoked' };
  }

  /**
   * Authenticate an incoming request via raw API key
   */
  static async authenticateApiKey(rawKey) {
    if (!rawKey || typeof rawKey !== 'string') return null;

    const trimmed = rawKey.trim();
    if (!trimmed.startsWith('dw_live_sec_') && !trimmed.startsWith('dw_test_sec_')) {
      return null;
    }

    const keyHash = crypto.createHash('sha256').update(trimmed).digest('hex');

    const [rows] = await pool.query(
      `SELECT k.id, k.business_id, k.user_id, k.environment, k.scopes_json, k.is_active,
              b.name AS business_name, b.trust_status, b.business_tier
       FROM api_keys k
       JOIN businesses b ON k.business_id = b.id
       WHERE k.key_hash = ? AND k.is_active = TRUE LIMIT 1`,
      [keyHash]
    );

    if (rows.length === 0) return null;

    const keyRecord = rows[0];

    // Fire and forget last_used update
    pool.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = ?', [keyRecord.id]).catch(() => {});

    return {
      authenticatedVia: 'api_key',
      keyId: keyRecord.id,
      businessId: keyRecord.business_id,
      businessName: keyRecord.business_name,
      userId: keyRecord.user_id,
      environment: keyRecord.environment,
      scopes: typeof keyRecord.scopes_json === 'string' ? JSON.parse(keyRecord.scopes_json) : (keyRecord.scopes_json || ['*']),
      role: 'owner'
    };
  }
}

export default ApiKeyService;
