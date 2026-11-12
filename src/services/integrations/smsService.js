import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import pool from '../../config/db.js';
import { AppError } from '../../utils/response.js';

const ROBASE_BASE_URL = process.env.ROBASE_BASE_URL || "https://api.robase.dev";
const ROBASE_API_KEY = process.env.ROBASE_API_KEY || process.env.ROBASE_SMS_API_KEY;

console.log("ROBASE BASE URL:", process.env.ROBASE_BASE_URL);
console.log(
  "ROBASE API KEY EXISTS:",
  !!process.env.ROBASE_API_KEY
);

class SmsService {
  /**
   * Normalizes phone numbers to international E.164 format (+234..., +1..., +44..., +254..., etc.)
   */
  static normalizePhoneNumber(phone, defaultCountryCode = '234') {
    if (!phone) return '';
    let cleaned = phone.replace(/[\s\-\(\)\.]/g, '').trim();

    // Already E.164 with leading plus
    if (cleaned.startsWith('+')) {
      return cleaned;
    }

    // Nigerian local 11-digit zero prefix (e.g. 08012345678)
    if (cleaned.startsWith('0') && cleaned.length === 11) {
      return '+234' + cleaned.substring(1);
    }

    // Numbers without plus but starting with country code (e.g. 23480..., 1212..., 447...)
    if (cleaned.startsWith('234') || cleaned.startsWith('233') || cleaned.startsWith('254') || cleaned.startsWith('27') || cleaned.startsWith('1')) {
      return '+' + cleaned;
    }

    // Default fallback
    if (!cleaned.startsWith('+')) {
      cleaned = '+' + (defaultCountryCode.replace('+', '') || '234') + (cleaned.startsWith('0') ? cleaned.substring(1) : cleaned);
    }
    return cleaned;
  }

  /**
   * Dispatches a 6-digit OTP code to the recipient's phone number via Robase
   * Supports 'registration', 'password_reset', and 'login'
   */
  static async sendOtp(phone, purpose) {
    const validPurposes = ['registration', 'login', 'password_reset'];
    if (!validPurposes.includes(purpose)) {
      throw new Error(`Invalid OTP purpose. Must be one of: ${validPurposes.join(', ')}`);
    }

    const normalizedPhone = this.normalizePhoneNumber(phone);
    if (!normalizedPhone || normalizedPhone.length < 8) {
      throw new Error('Invalid international phone number format. Expected format: +2348012345678 or +12125551234');
    }

    // 1. Generate cryptographically strong 6-digit numeric code
    const rawOtp = String(crypto.randomInt(100000, 1000000));
    const otpHash = await bcrypt.hash(rawOtp, 10);
    const id = crypto.randomUUID();

    // 2. Set expiry to 10 minutes from now
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    // 3. Save to otp_verifications table
    await pool.query(
      `INSERT INTO otp_verifications (id, phone, otp_hash, purpose, attempts, expires_at, created_at)
       VALUES (?, ?, ?, ?, 0, ?, NOW())`,
      [id, normalizedPhone, otpHash, purpose, expiresAt]
    );

    // 4. Formulate contextual message
    let message = '';
    if (purpose === 'registration') {
      message = `Your Digital Watchdog account verification code is ${rawOtp}. Valid for 10 minutes. Do NOT share this code.`;
    } else if (purpose === 'password_reset') {
      message = `Your Digital Watchdog password reset code is ${rawOtp}. Valid for 10 minutes. Do NOT share this code.`;
    } else {
      message = `Your Digital Watchdog security code is ${rawOtp}. Valid for 10 minutes. Do NOT share this code.`;
    }

    const activeApiKey = process.env.ROBASE_API_KEY || ROBASE_API_KEY;
    const activeBaseUrl = process.env.ROBASE_BASE_URL || ROBASE_BASE_URL || "https://api.robase.dev";
    const isMock = process.env.MOCK_SMS === 'true' || 
                   !activeApiKey || 
                   activeApiKey.startsWith('mock_') || 
                   activeApiKey.includes('test_placeholder');

    if (!isMock && activeApiKey) {
      try {
        console.log(`[Robase SMS] Dispatching ${purpose} OTP to ${normalizedPhone} via ${activeBaseUrl}...`);
        const response = await fetch(`${activeBaseUrl}/v1/sms/send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${activeApiKey}`
          },
          body: JSON.stringify({
            phone_number: normalizedPhone,
            sender_id: process.env.ROBASE_SMS_SENDER_ID || 'WATCHDOG',
            message: message
          })
        });

        const respText = await response.text();
        let respJson = null;
        try {
          respJson = JSON.parse(respText);
        } catch {
          // Non-JSON response
        }

        if (!response.ok) {
          const errMsg = respJson?.error?.message || respJson?.message || (typeof respJson?.error === 'string' ? respJson.error : null) || response.statusText;
          console.error(`[Robase SMS Error]: HTTP ${response.status}`, respJson || respText);
          if (process.env.NODE_ENV === 'production') {
            throw new AppError(`SMS Gateway dispatch failed: ${errMsg}`, 502, 'SMS_DISPATCH_FAILED');
          }
        } else {
          console.log(`[Robase SMS Delivered]: HTTP ${response.status} to ${normalizedPhone}`, respJson || respText);
        }
      } catch (err) {
        console.error('[Robase SMS Dispatch Exception]:', err.message);
        if (err instanceof AppError) throw err;
      }
    } else {
      console.log('================================================================');
      console.log(`📱 [ROBASE SMS DISPATCH (MOCK / LOCAL DEV)]`);
      console.log(`   Provider: Robase (Base URL: ${activeBaseUrl})`);
      console.log(`   To:       ${normalizedPhone}`);
      console.log(`   OTP Code: ${rawOtp}`);
      console.log(`   Purpose:  ${purpose}`);
      console.log(`   Expires:  10 minutes (${expiresAt.toISOString()})`);
      console.log(`   Message:  "${message}"`);
      if (!activeApiKey || activeApiKey.startsWith('mock_')) {
        console.log(`   Notice:   Set live ROBASE_API_KEY in backend/.env to send real network SMS`);
      }
      console.log('================================================================');
    }

    return {
      success: true,
      message: `OTP sent successfully to ${normalizedPhone}`,
      phone: normalizedPhone,
      expires_in_seconds: 600,
      rawOtp: rawOtp
    };
  }

  /**
   * Verifies an OTP code against active unconsumed records
   */
  static async verifyOtp(phone, code, purpose) {
    const normalizedPhone = this.normalizePhoneNumber(phone);

    if (!code || code.trim().length !== 6) {
      const err = new Error('Verification code must be exactly 6 digits');
      err.code = 'INVALID_OTP_FORMAT';
      err.status = 400;
      throw err;
    }

    // Find latest active, unconsumed OTP
    const [rows] = await pool.query(
      `SELECT * FROM otp_verifications 
       WHERE phone = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > NOW() 
       ORDER BY created_at DESC LIMIT 1`,
      [normalizedPhone, purpose]
    );

    if (rows.length === 0) {
      const err = new Error('No active verification code found for this phone number or code has expired. Please request a new OTP.');
      err.code = 'OTP_EXPIRED_OR_NOT_FOUND';
      err.status = 400;
      throw err;
    }

    const record = rows[0];

    // Enforce max 3 attempts
    if (record.attempts >= 3) {
      const err = new Error('Maximum verification attempts (3) exceeded for this code. Please request a new OTP.');
      err.code = 'OTP_MAX_ATTEMPTS_EXCEEDED';
      err.status = 400;
      throw err;
    }

    // Verify bcrypt hash
    const isMatch = await bcrypt.compare(code.trim(), record.otp_hash);

    if (!isMatch) {
      const newAttempts = record.attempts + 1;
      await pool.query('UPDATE otp_verifications SET attempts = ? WHERE id = ?', [newAttempts, record.id]);
      const remaining = 3 - newAttempts;
      const err = new Error(`Invalid verification code. Attempts remaining: ${remaining}`);
      err.code = 'INVALID_OTP';
      err.status = 400;
      throw err;
    }

    // Code matches: mark as consumed
    await pool.query('UPDATE otp_verifications SET consumed_at = NOW() WHERE id = ?', [record.id]);

    return {
      verified: true,
      phone: normalizedPhone,
      purpose: purpose,
      verified_at: new Date().toISOString()
    };
  }

  /**
   * Send arbitrary transactional SMS notification via Robase
   */
  static async sendSms(phone, message) {
    const normalizedPhone = this.normalizePhoneNumber(phone);
    if (!normalizedPhone) return false;

    const activeApiKey = process.env.ROBASE_API_KEY || ROBASE_API_KEY;
    const activeBaseUrl = process.env.ROBASE_BASE_URL || ROBASE_BASE_URL || "https://api.robase.dev";
    const isMock = process.env.MOCK_SMS === 'true' || 
                   !activeApiKey || 
                   activeApiKey.startsWith('mock_') || 
                   activeApiKey.includes('test_placeholder');

    if (!isMock && activeApiKey) {
      try {
        const response = await fetch(`${activeBaseUrl}/v1/sms/send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${activeApiKey}`
          },
          body: JSON.stringify({
            phone_number: normalizedPhone,
            sender_id: process.env.ROBASE_SMS_SENDER_ID || 'WATCHDOG',
            message: message
          })
        });
        return response.ok;
      } catch (err) {
        console.error('[Robase SendSms Exception]:', err.message);
        return false;
      }
    } else {
      console.log(`📱 [ROBASE SMS DISPATCH (MOCK)] To: ${normalizedPhone} | Msg: ${message}`);
      return true;
    }
  }
}

export default SmsService;
