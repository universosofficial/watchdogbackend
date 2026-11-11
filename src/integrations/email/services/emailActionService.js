/**
 * Email Action Token Service
 * Creates and verifies tamper-proof cryptographic action tokens for 1-click email buttons
 */
import crypto from 'crypto';

const ACTION_SECRET = process.env.JWT_SECRET || 'digital_watchdog_email_action_secret_key_2026';

export class EmailActionService {
  /**
   * Generate signed base64url token for an email action
   */
  static generateActionToken(action, payload, expiresInMs = 7 * 86400000) {
    const data = {
      action,
      payload,
      exp: Date.now() + expiresInMs
    };

    const dataJson = JSON.stringify(data);
    const dataB64 = Buffer.from(dataJson).toString('base64url');
    const signature = crypto
      .createHmac('sha256', ACTION_SECRET)
      .update(dataB64)
      .digest('base64url');

    return `${dataB64}.${signature}`;
  }

  /**
   * Verify token integrity and expiration
   */
  static verifyActionToken(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) {
      throw new Error('Invalid token format');
    }

    const [dataB64, signature] = token.split('.');
    const expectedSig = crypto
      .createHmac('sha256', ACTION_SECRET)
      .update(dataB64)
      .digest('base64url');

    if (signature !== expectedSig) {
      throw new Error('Cryptographic signature mismatch or token tampered');
    }

    const dataJson = Buffer.from(dataB64, 'base64url').toString('utf8');
    const data = JSON.parse(dataJson);

    if (Date.now() > data.exp) {
      throw new Error('Action link has expired. Please sign in via the web workspace.');
    }

    return data;
  }
}

export default EmailActionService;
