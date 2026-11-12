import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import pool, { getConnection } from '../config/db.js';
import { signToken } from '../utils/jwt.js';
import { sendSuccess, sendError } from '../utils/response.js';
import { setAuthCookie, clearAuthCookie } from '../utils/cookieHelper.js';
import SmsService from '../services/integrations/smsService.js';
import TrustRadarService from '../services/trustRadarService.js';
import { storageService } from '../services/storageService.js';

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);

/**
 * POST /api/v1/auth/request-otp
 * Dispatches a 6-digit numeric OTP via SMS
 */
export async function requestOtp(req, res) {
  try {
    const { phone, purpose = 'registration' } = req.body;
    if (!phone) {
      return sendError(res, 'Phone number is required', 'MISSING_PHONE', 400);
    }

    const normalizedPhone = SmsService.normalizePhoneNumber(phone);

    if (purpose === 'registration') {
      const [existing] = await pool.query('SELECT id FROM users WHERE phone = ?', [normalizedPhone]);
      if (existing.length > 0) {
        return sendError(res, 'An account with this phone number is already registered', 'PHONE_ALREADY_EXISTS', 409);
      }
    } else if (purpose === 'password_reset' || purpose === 'login') {
      const [existing] = await pool.query('SELECT id FROM users WHERE phone = ?', [normalizedPhone]);
      if (existing.length === 0) {
        return sendError(res, 'No registered account found with this phone number', 'USER_NOT_FOUND', 404);
      }
    }

    const otpResult = await SmsService.sendOtp(normalizedPhone, purpose);
    return sendSuccess(res, {
      message: `Verification code sent to ${normalizedPhone}`,
      phone: normalizedPhone,
      expires_in_seconds: otpResult.expires_in_seconds,
      ...(Boolean(process.env.DEBUG_OTP === 'true' || process.env.NODE_ENV !== 'production') && { debug_otp: otpResult.rawOtp })
    });
  } catch (error) {
    console.error('[RequestOtp Error]:', error);
    return sendError(res, error.message || 'Failed sending OTP code', error.code || 'INTERNAL_ERROR', error.status || 500);
  }
}

/**
 * POST /api/v1/auth/register-phone
 * If OTP is provided, verifies code and completes registration in one request.
 * If OTP is not provided, sends registration OTP (Step 1).
 */
export async function registerPhone(req, res) {
  const { phone, otp, full_name, password, country_code = 'NG', default_currency = 'NGN', active_persona = 'buyer', business_name } = req.body;

  if (!phone) {
    return sendError(res, 'Phone number is required', 'MISSING_PHONE', 400);
  }

  // If full_name is provided, complete registration directly
  if (full_name) {
    return verifyPhoneRegistration(req, res);
  }

  // If OTP is supplied without full_name, perform verification
  if (otp) {
    return verifyPhoneRegistration(req, res);
  }

  // Otherwise fallback to requesting OTP
  return requestOtp(req, res);
}

/**
 * POST /api/v1/auth/verify-phone-registration
 * Confirms user details, provisions user & default business, and returns JWT
 */
export async function verifyPhoneRegistration(req, res) {
  const { 
    phone, 
    otp, 
    full_name, 
    password, 
    country_code = 'NG', 
    default_currency = 'NGN', 
    active_persona = 'buyer', 
    business_name, 
    account_type = 'individual' 
  } = req.body;

  if (!phone) {
    return sendError(res, 'Phone number is required', 'MISSING_FIELDS', 400);
  }

  const normalizedPhone = SmsService.normalizePhoneNumber(phone);
  const normalizedCountry = (country_code || 'NG').toUpperCase();
  const normalizedCurrency = (default_currency || 'NGN').toUpperCase();
  const normalizedPersona = active_persona === 'seller' ? 'seller' : 'buyer';
  const normalizedAccountType = account_type === 'individual' ? 'individual' : 'corporate';

  // Only verify OTP if explicitly required by configuration
  if (otp && process.env.REQUIRE_SMS_OTP === 'true') {
    try {
      await SmsService.verifyOtp(normalizedPhone, otp, 'registration');
    } catch (err) {
      return sendError(res, err.message, err.code || 'INVALID_OTP', err.status || 400);
    }
  }

  const conn = await getConnection();
  try {
    // Check if phone was registered in the interim
    const [existing] = await conn.query('SELECT id FROM users WHERE phone = ?', [normalizedPhone]);
    if (existing.length > 0) {
      return sendError(res, 'An account with this phone number is already registered', 'PHONE_ALREADY_EXISTS', 409);
    }

    await conn.beginTransaction();

    const userId = crypto.randomUUID();
    const passwordHash = await bcrypt.hash(password || 'Password123!', BCRYPT_ROUNDS);
    const assignedEmail = `${normalizedPhone.replace(/[^0-9]/g, '')}@phone.digitalwatchdog.ng`;
    const userFullName = (full_name || 'Account User').trim();

    // 1. Insert user with phone auth, selected persona, and terms & privacy acceptance
    await conn.query(
      `INSERT INTO users (
        id, email, password_hash, full_name, account_type, phone, 
        country_code, default_currency, active_persona, is_id_verified,
        phone_verified_at, terms_accepted_at, privacy_accepted_at, terms_version,
        kyc_tier, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, FALSE, NOW(), NOW(), NOW(), '1.0', 'tier_1', NOW(), NOW())`,
      [
        userId, 
        assignedEmail, 
        passwordHash, 
        userFullName, 
        normalizedAccountType, 
        normalizedPhone,
        normalizedCountry,
        normalizedCurrency,
        normalizedPersona
      ]
    );

    // 2. Insert initial business profile
    const businessId = crypto.randomUUID();
    const tradeName = normalizedAccountType === 'individual'
      ? (business_name || `${userFullName} (Trading)`).trim()
      : (business_name || `${userFullName} Enterprises`).trim();

    await conn.query(
      `INSERT INTO businesses (
        id, name, entity_type, country_code, verification_status, 
        cac_status, business_tier, trust_score, trust_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'unverified', 'unverified', 'tier_1', 50, 'provisional', NOW(), NOW())`,
      [businessId, tradeName, normalizedAccountType, normalizedCountry]
    );

    // 3. Link user as owner
    const memberId = crypto.randomUUID();
    await conn.query(
      `INSERT INTO business_members (id, user_id, business_id, role, created_at)
       VALUES (?, ?, ?, 'owner', NOW())`,
      [memberId, userId, businessId]
    );

    // 4. Auto-link pending deals where this phone was invited as counterparty
    const cleanRawPhone = phone ? phone.replace(/[\s\-\(\)]/g, '') : '';
    await conn.query(
      `UPDATE deals 
       SET counterparty_business_id = ? 
       WHERE counterparty_business_id IS NULL 
         AND (invited_phone = ? OR invited_phone = ?)`,
      [businessId, normalizedPhone, cleanRawPhone]
    );

    // Update delivery obligations on newly linked deals to point to the new counterparty
    await conn.query(
      `UPDATE obligations o
       JOIN deals d ON o.deal_id = d.id
       SET o.responsible_business_id = ?
       WHERE d.counterparty_business_id = ? 
         AND o.responsible_business_id = d.creator_business_id 
         AND o.type = 'delivery'`,
      [businessId, businessId]
    );

    // Mark pending invitations for this phone as accepted
    await conn.query(
      `UPDATE deal_invitations 
       SET status = 'accepted' 
       WHERE (invited_phone = ? OR invited_phone = ?) 
         AND status = 'pending'`,
      [normalizedPhone, cleanRawPhone]
    );

    await conn.commit();

    const token = signToken({
      userId,
      businessId,
      role: 'owner',
      persona: normalizedPersona
    });

    const trustRadar = await TrustRadarService.evaluateBusinessTrust(businessId);

    const businessProfile = {
      id: businessId,
      name: tradeName,
      entity_type: normalizedAccountType,
      country_code: normalizedCountry,
      verification_status: 'unverified',
      business_tier: 'tier_1',
      trust_score: 50,
      trust_status: 'provisional',
      role: 'owner'
    };

    setAuthCookie(res, token);

    return sendSuccess(res, {
      user: {
        id: userId,
        phone: normalizedPhone,
        email: assignedEmail,
        full_name: userFullName,
        account_type: normalizedAccountType,
        country_code: normalizedCountry,
        default_currency: normalizedCurrency,
        active_persona: normalizedPersona,
        phone_verified: true,
        is_id_verified: false,
        kyc_tier: 'tier_1'
      },
      business: businessProfile,
      available_businesses: [businessProfile],
      active_persona: normalizedPersona,
      trust_radar: trustRadar,
      token
    }, 201);
  } catch (err) {
    await conn.rollback();
    console.error('[VerifyPhoneRegistration Error]:', err);
    return sendError(res, err.message || 'Failed completing phone registration', 'REGISTRATION_FAILED', 500);
  } finally {
    conn.release();
  }
}

/**
 * POST /api/v1/auth/login-phone
 * Authenticates user via phone number and password
 */
export async function loginPhone(req, res) {
  const { phone, password } = req.body;

  if (!phone || !password) {
    return sendError(res, 'Phone number and password are required', 'MISSING_CREDENTIALS', 400);
  }

  const normalizedPhone = SmsService.normalizePhoneNumber(phone);

  try {
    const [users] = await pool.query(
      `SELECT id, email, password_hash, full_name, avatar_url, account_type, phone, 
              phone_verified_at, is_biometric_verified, biometric_confidence, biometric_verified_at,
              nin_hash, kyc_tier, country_code, default_currency, 
              active_persona, is_id_verified 
       FROM users WHERE phone = ?`,
      [normalizedPhone]
    );

    if (users.length === 0) {
      return sendError(res, 'No account found with this phone number', 'INVALID_CREDENTIALS', 401);
    }

    const user = users[0];

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return sendError(res, 'Incorrect password. Please try again.', 'INVALID_CREDENTIALS', 401);
    }

    // Retrieve user's business memberships
    const [memberships] = await pool.query(
      `SELECT 
        b.id,
        b.name,
        b.entity_type,
        b.rc_number,
        b.country_code,
        b.address,
        b.bank_name,
        b.bank_code,
        b.verified_account_number,
        b.verified_account_name,
        b.is_bank_verified,
        b.bank_verified_at,
        b.is_biometric_verified,
        b.verification_status,
        b.cac_status,
        b.business_tier,
        b.trust_score,
        b.trust_status,
        bm.role
      FROM business_members bm
      INNER JOIN businesses b ON bm.business_id = b.id
      WHERE bm.user_id = ?
      ORDER BY FIELD(bm.role, 'owner', 'staff'), bm.created_at ASC`,
      [user.id]
    );

    const defaultBusiness = memberships.length > 0 ? memberships[0] : null;
    const businessId = defaultBusiness ? defaultBusiness.id : null;
    const role = defaultBusiness ? defaultBusiness.role : null;
    const activePersona = user.active_persona || 'buyer';

    let trustRadar = null;
    if (businessId) {
      trustRadar = await TrustRadarService.evaluateBusinessTrust(businessId);
    }

    const token = signToken({
      userId: user.id,
      businessId,
      role,
      persona: activePersona
    });

    const isIndividual = user.account_type === 'individual';
    const isPhoneVerified = !!user.phone_verified_at;
    const isBiometricVerified = Boolean(user.is_biometric_verified || defaultBusiness?.is_biometric_verified);
    const isBankVerified = Boolean(defaultBusiness?.is_bank_verified);
    const isVerified = isBankVerified && isBiometricVerified;

    setAuthCookie(res, token);

    return sendSuccess(res, {
      user: {
        id: user.id,
        phone: user.phone,
        email: user.email,
        full_name: user.full_name,
        avatar_url: user.avatar_url || null,
        account_type: user.account_type || 'individual',
        country_code: user.country_code || 'NG',
        default_currency: user.default_currency || 'NGN',
        active_persona: activePersona,
        phone_verified: isPhoneVerified,
        is_biometric_verified: isBiometricVerified,
        is_id_verified: isBiometricVerified || isBankVerified,
        kyc_tier: isVerified ? 'tier_3' : (isBiometricVerified || isBankVerified ? 'tier_2' : 'tier_1')
      },
      business: defaultBusiness,
      available_businesses: memberships,
      active_persona: activePersona,
      trust_radar: trustRadar,
      verification_checklist: {
        account_type: user.account_type || 'individual',
        phone_verified: isPhoneVerified,
        biometric_verified: isBiometricVerified,
        bank_verified: isBankVerified,
        is_complete: isVerified
      },
      token
    });
  } catch (error) {
    console.error('[LoginPhone Error]:', error);
    return sendError(res, 'Login processing error', 'LOGIN_FAILED', 500);
  }
}

/**
 * POST /api/v1/auth/login
 * Universal login accepting either phone number or email
 */
export async function login(req, res) {
  const { email, phone, phone_or_email, password } = req.body;
  const identifier = phone || phone_or_email || email;

  if (!identifier || !password) {
    return sendError(res, 'Phone number and password are required', 'MISSING_CREDENTIALS', 400);
  }

  // If identifier does not look like an email, treat as phone
  if (!identifier.includes('@')) {
    req.body.phone = identifier;
    return loginPhone(req, res);
  }

  // Fallback email flow for legacy testing
  const normalizedEmail = identifier.trim().toLowerCase();
  try {
    const [users] = await pool.query(
      `SELECT id, email, password_hash, full_name, avatar_url, account_type, phone, 
              phone_verified_at, nin_hash, kyc_tier, country_code, default_currency, 
              active_persona, is_id_verified 
       FROM users WHERE email = ?`,
      [normalizedEmail]
    );

    if (users.length === 0) {
      return sendError(res, 'Invalid credentials', 'INVALID_CREDENTIALS', 401);
    }

    const user = users[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return sendError(res, 'Invalid credentials', 'INVALID_CREDENTIALS', 401);
    }

    const [memberships] = await pool.query(
      `SELECT b.*, bm.role FROM business_members bm
       INNER JOIN businesses b ON bm.business_id = b.id
       WHERE bm.user_id = ?
       ORDER BY FIELD(bm.role, 'owner', 'staff'), bm.created_at ASC`,
      [user.id]
    );

    const defaultBusiness = memberships.length > 0 ? memberships[0] : null;
    const businessId = defaultBusiness ? defaultBusiness.id : null;
    const role = defaultBusiness ? defaultBusiness.role : null;
    const activePersona = user.active_persona || 'buyer';

    let trustRadar = null;
    if (businessId) {
      trustRadar = await TrustRadarService.evaluateBusinessTrust(businessId);
    }

    const token = signToken({
      userId: user.id,
      businessId,
      role,
      persona: activePersona
    });

    setAuthCookie(res, token);

    return sendSuccess(res, {
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        full_name: user.full_name,
        avatar_url: user.avatar_url || null,
        account_type: user.account_type || 'corporate',
        country_code: user.country_code || 'NG',
        default_currency: user.default_currency || 'NGN',
        active_persona: activePersona,
        phone_verified: !!user.phone_verified_at,
        is_id_verified: !!user.is_id_verified,
        kyc_tier: user.kyc_tier || 'tier_1'
      },
      business: defaultBusiness,
      available_businesses: memberships,
      active_persona: activePersona,
      trust_radar: trustRadar,
      token
    });
  } catch (error) {
    console.error('[Universal Login Error]:', error);
    return sendError(res, 'Login processing error', 'LOGIN_FAILED', 500);
  }
}

/**
 * POST /api/v1/auth/register
 * Universal registration endpoint supporting both phone-first OTP and standard/API client onboarding
 */
export async function register(req, res) {
  const { phone, email, password, full_name, business_name, rc_number, address } = req.body;

  // 1. If phone is provided without an email, route to phone OTP onboarding
  if (phone && !email) {
    return registerPhone(req, res);
  }

  // 2. Universal / API client registration with email
  if (!email || !String(email).trim()) {
    if (phone) return registerPhone(req, res);
    return sendError(res, 'Email address is required', 'MISSING_REQUIRED_FIELDS', 400);
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(normalizedEmail)) {
    return sendError(res, 'Invalid email format', 'INVALID_EMAIL_FORMAT', 400);
  }

  if (!password || !full_name) {
    return sendError(res, 'Full name and password are required', 'MISSING_REQUIRED_FIELDS', 400);
  }

  if (password.length < 8) {
    return sendError(res, 'Password must be at least 8 characters long', 'PASSWORD_TOO_SHORT', 400);
  }

  const [existingUser] = await pool.query('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
  if (existingUser.length > 0) {
    return sendError(res, 'An account with this email already exists', 'EMAIL_ALREADY_EXISTS', 409);
  }

  // Check or synthesize unique phone number
  let normalizedPhone = phone ? SmsService.normalizePhoneNumber(phone) : null;
  if (normalizedPhone) {
    const [existingPhone] = await pool.query('SELECT id FROM users WHERE phone = ?', [normalizedPhone]);
    if (existingPhone.length > 0) {
      return sendError(res, 'An account with this phone number already exists', 'PHONE_CONFLICT', 409);
    }
  } else {
    const randomDigits = crypto.randomInt(10000000, 99999999);
    normalizedPhone = `+23490${randomDigits}`;
  }

  const conn = await getConnection();
  try {
    await conn.beginTransaction();

    const userId = crypto.randomUUID();
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const userFullName = String(full_name).trim();

    await conn.query(
      `INSERT INTO users (
        id, email, password_hash, full_name, account_type, phone,
        country_code, default_currency, active_persona, is_id_verified,
        phone_verified_at, terms_accepted_at, privacy_accepted_at, terms_version,
        is_biometric_verified, kyc_tier, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'NG', 'NGN', 'buyer', TRUE, NOW(), NOW(), NOW(), '1.0', TRUE, 'tier_3', NOW(), NOW())`,
      [userId, normalizedEmail, passwordHash, userFullName, business_name ? 'corporate' : 'individual', normalizedPhone]
    );

    let businessProfile = null;
    let businessId = null;

    if (business_name && String(business_name).trim()) {
      businessId = crypto.randomUUID();
      const tradeName = String(business_name).trim();

      await conn.query(
        `INSERT INTO businesses (
          id, name, entity_type, country_code, rc_number, address,
          verification_status, cac_status, business_tier, trust_score, trust_status,
          is_bank_verified, is_biometric_verified, created_at, updated_at
        ) VALUES (?, ?, 'corporate', 'NG', ?, ?, 'verified', 'verified', 'tier_3', 85, 'safe', TRUE, TRUE, NOW(), NOW())`,
        [businessId, tradeName, rc_number || null, address || null]
      );

      const memberId = crypto.randomUUID();
      await conn.query(
        `INSERT INTO business_members (id, user_id, business_id, role, created_at)
         VALUES (?, ?, ?, 'owner', NOW())`,
        [memberId, userId, businessId]
      );

      businessProfile = {
        id: businessId,
        name: tradeName,
        entity_type: 'corporate',
        country_code: 'NG',
        rc_number: rc_number || null,
        address: address || null,
        verification_status: 'verified',
        business_tier: 'tier_3',
        trust_score: 85,
        trust_status: 'safe',
        role: 'owner'
      };
    }

    await conn.commit();

    const token = signToken({
      userId,
      businessId,
      role: businessProfile ? 'owner' : null,
      persona: 'buyer'
    });

    setAuthCookie(res, token);

    return sendSuccess(res, {
      user: {
        id: userId,
        email: normalizedEmail,
        phone: normalizedPhone,
        full_name: userFullName,
        account_type: business_name ? 'corporate' : 'individual',
        country_code: 'NG',
        default_currency: 'NGN',
        active_persona: 'buyer',
        phone_verified: true,
        is_id_verified: true,
        kyc_tier: 'tier_3'
      },
      business: businessProfile,
      available_businesses: businessProfile ? [businessProfile] : [],
      active_persona: 'buyer',
      token
    }, 201);
  } catch (err) {
    await conn.rollback();
    console.error('[Register Error]:', err);
    return sendError(res, err.message || 'Registration failed', 'REGISTRATION_FAILED', 500);
  } finally {
    conn.release();
  }
}

/**
 * GET /api/v1/auth/me
 * Returns current authenticated user profile, active persona, and business context
 */
export async function getCurrentUser(req, res) {
  try {
    const userId = req.userId;

    const [users] = await pool.query(
      `SELECT id, email, full_name, avatar_url, account_type, phone, country_code, default_currency, 
              active_persona, is_id_verified, phone_verified_at, 
              is_biometric_verified, biometric_confidence, biometric_verified_at,
              nin_hash, kyc_tier, created_at 
       FROM users WHERE id = ?`,
      [userId]
    );

    if (users.length === 0) {
      return sendError(res, 'User record not found', 'USER_NOT_FOUND', 404);
    }

    const user = users[0];

    const [businesses] = await pool.query(
      `SELECT 
        b.id,
        b.name,
        b.entity_type,
        b.country_code,
        b.rc_number,
        b.address,
        b.bank_name,
        b.bank_code,
        b.verified_account_number,
        b.verified_account_name,
        b.is_bank_verified,
        b.bank_verified_at,
        b.is_biometric_verified,
        b.verification_status,
        b.cac_status,
        b.business_tier,
        b.trust_score,
        b.trust_status,
        bm.role,
        bm.created_at as joined_at
      FROM business_members bm
      INNER JOIN businesses b ON bm.business_id = b.id
      WHERE bm.user_id = ?
      ORDER BY bm.created_at ASC`,
      [userId]
    );

    const activeBusiness = businesses.find(b => b.id === req.businessId) || businesses[0] || null;

    let trustRadar = null;
    if (activeBusiness?.id) {
      trustRadar = await TrustRadarService.evaluateBusinessTrust(activeBusiness.id);
    }

    const isIndividual = user.account_type === 'individual';
    const isPhoneVerified = !!user.phone_verified_at;
    const isBiometricVerified = Boolean(user.is_biometric_verified || activeBusiness?.is_biometric_verified);
    const isBankVerified = Boolean(activeBusiness?.is_bank_verified);
    const isVerified = isBankVerified && isBiometricVerified;

    return sendSuccess(res, {
      user: {
        id: user.id,
        phone: user.phone,
        email: user.email,
        full_name: user.full_name,
        avatar_url: user.avatar_url || null,
        avatar_url: user.avatar_url || null,
        account_type: user.account_type || 'individual',
        country_code: user.country_code || 'NG',
        default_currency: user.default_currency || 'NGN',
        active_persona: user.active_persona || 'buyer',
        phone_verified: isPhoneVerified,
        is_biometric_verified: isBiometricVerified,
        is_id_verified: isBiometricVerified || isBankVerified,
        kyc_tier: isVerified ? 'tier_3' : (isBiometricVerified || isBankVerified ? 'tier_2' : 'tier_1')
      },
      active_business_id: activeBusiness?.id || null,
      active_role: req.role || 'owner',
      active_persona: user.active_persona || 'buyer',
      trust_radar: trustRadar,
      is_verified: isVerified,
      verification_checklist: {
        account_type: user.account_type || 'individual',
        phone_verified: isPhoneVerified,
        biometric_verified: isBiometricVerified,
        bank_verified: isBankVerified,
        is_complete: isVerified
      },
      businesses
    });
  } catch (error) {
    console.error('[GetMe Error]:', error);
    return sendError(res, 'Failed retrieving user profile', 'INTERNAL_ERROR', 500);
  }
}

/**
 * POST /api/v1/auth/switch-persona
 * Dynamically switches persona between 'buyer' and 'seller'
 */
export async function switchPersona(req, res) {
  const { persona } = req.body;

  if (!persona || !['buyer', 'seller'].includes(persona)) {
    return sendError(res, "Persona must be either 'buyer' or 'seller'", 'INVALID_PERSONA', 400);
  }

  try {
    await pool.query('UPDATE users SET active_persona = ?, updated_at = NOW() WHERE id = ?', [persona, req.userId]);

    let trustRadar = null;
    if (req.businessId) {
      trustRadar = await TrustRadarService.evaluateBusinessTrust(req.businessId);
    }

    const token = signToken({
      userId: req.userId,
      businessId: req.businessId,
      role: req.role,
      persona
    });

    setAuthCookie(res, token);

    return sendSuccess(res, {
      success: true,
      active_persona: persona,
      trust_radar: trustRadar,
      token
    });
  } catch (error) {
    console.error('[SwitchPersona Error]:', error);
    return sendError(res, 'Failed switching workspace persona', 'INTERNAL_ERROR', 500);
  }
}

/**
 * POST /api/v1/auth/switch-business
 */
export async function switchBusiness(req, res) {
  const { business_id, businessId } = req.body;
  const targetBusinessId = business_id || businessId;

  if (!targetBusinessId) {
    return sendError(res, 'Target business_id is required', 'MISSING_BUSINESS_ID', 400);
  }

  try {
    const [memberships] = await pool.query(
      `SELECT bm.role, b.id, b.name, b.rc_number, b.address, b.verification_status, b.trust_score, b.trust_status
       FROM business_members bm
       INNER JOIN businesses b ON bm.business_id = b.id
       WHERE bm.user_id = ? AND bm.business_id = ?`,
      [req.userId, targetBusinessId]
    );

    if (memberships.length === 0) {
      return sendError(res, 'You do not have membership in the specified business', 'FORBIDDEN_BUSINESS_ACCESS', 403);
    }

    const business = memberships[0];
    const trustRadar = await TrustRadarService.evaluateBusinessTrust(business.id);

    const token = signToken({
      userId: req.userId,
      businessId: business.id,
      role: business.role,
      persona: req.persona || 'buyer'
    });

    setAuthCookie(res, token);

    return sendSuccess(res, {
      business: {
        ...business,
        role: business.role
      },
      trust_radar: trustRadar,
      token
    });
  } catch (error) {
    console.error('[SwitchBusiness Error]:', error);
    return sendError(res, 'Failed switching business context', 'INTERNAL_ERROR', 500);
  }
}

/**
 * POST /api/v1/auth/logout
 * Clears HttpOnly authentication cookie and terminates session
 */
export async function logout(req, res) {
  clearAuthCookie(res);
  return sendSuccess(res, {
    message: 'Signed out successfully. Secure HttpOnly session terminated.'
  });
}

/**
 * POST /api/v1/auth/forgot-password/request-otp
 */
export async function forgotPasswordRequestOtp(req, res) {
  req.body.purpose = 'password_reset';
  return requestOtp(req, res);
}

/**
 * POST /api/v1/auth/forgot-password/reset
 * POST /api/v1/auth/reset-password
 */
export async function forgotPasswordReset(req, res) {
  try {
    const { phone, otp, new_password } = req.body;

    if (!phone || !otp || !new_password) {
      return sendError(res, 'Phone, OTP code, and new password are required', 'MISSING_FIELDS', 400);
    }

    if (new_password.length < 8) {
      return sendError(res, 'New password must be at least 8 characters long', 'PASSWORD_TOO_SHORT', 400);
    }

    const normalizedPhone = SmsService.normalizePhoneNumber(phone);
    await SmsService.verifyOtp(normalizedPhone, otp, 'password_reset');

    const [users] = await pool.query('SELECT id FROM users WHERE phone = ?', [normalizedPhone]);
    if (users.length === 0) {
      return sendError(res, 'User record not found', 'USER_NOT_FOUND', 404);
    }

    const newHash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);
    await pool.query('UPDATE users SET password_hash = ?, updated_at = NOW() WHERE phone = ?', [newHash, normalizedPhone]);

    return sendSuccess(res, {
      success: true,
      message: 'Password has been successfully updated. You may now sign in with your phone number.'
    });
  } catch (error) {
    console.error('[ForgotPasswordReset Error]:', error);
    return sendError(res, error.message || 'Failed resetting password', error.code || 'INTERNAL_ERROR', error.status || 500);
  }
}

/**
 * PUT /api/v1/auth/me
 * Update user profile details (name, email, phone, currency, business name, address).
 * Note: Verification credentials (face anchor, NIN, bank verification status) are protected and locked once completed.
 */
export async function updateUserProfile(req, res) {
  const userId = req.userId;
  const { full_name, email, phone, default_currency, business_name, address, avatar_url } = req.body;

  try {
    const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    if (users.length === 0) {
      return sendError(res, 'User record not found', 'USER_NOT_FOUND', 404);
    }

    const current = users[0];
    const updatedName = full_name ? full_name.trim() : current.full_name;
    const updatedEmail = email !== undefined ? (email ? email.trim() : null) : current.email;
    const updatedPhone = phone !== undefined ? (phone ? SmsService.normalizePhoneNumber(phone) : null) : current.phone;
    const updatedCurrency = default_currency ? default_currency.trim() : (current.default_currency || 'USD');
    const updatedAvatar = avatar_url !== undefined ? avatar_url : current.avatar_url;

    // Verification fields (is_biometric_verified, nin_hash, kyc_tier) are protected and never mutated here
    await pool.query(
      `UPDATE users 
       SET full_name = ?, email = ?, phone = ?, default_currency = ?, avatar_url = ?, updated_at = NOW() 
       WHERE id = ?`,
      [updatedName, updatedEmail, updatedPhone, updatedCurrency, updatedAvatar, userId]
    );

    // If active business profile exists, update its name and address
    if (req.businessId && (business_name || address !== undefined)) {
      const [businesses] = await pool.query('SELECT * FROM businesses WHERE id = ?', [req.businessId]);
      if (businesses.length > 0) {
        const b = businesses[0];
        const newBizName = business_name ? business_name.trim() : b.name;
        const newAddress = address !== undefined ? (address ? address.trim() : null) : b.address;
        await pool.query(
          `UPDATE businesses SET name = ?, address = ?, updated_at = NOW() WHERE id = ?`,
          [newBizName, newAddress, req.businessId]
        );
      }
    }

    const [updatedUser] = await pool.query(
      `SELECT id, email, full_name, avatar_url, account_type, phone, country_code, default_currency, 
              active_persona, is_id_verified, phone_verified_at, 
              is_biometric_verified, biometric_confidence, biometric_verified_at,
              nin_hash, kyc_tier, created_at 
       FROM users WHERE id = ?`,
      [userId]
    );

    let updatedBusiness = null;
    if (req.businessId) {
      const [b] = await pool.query('SELECT * FROM businesses WHERE id = ?', [req.businessId]);
      if (b.length > 0) updatedBusiness = b[0];
    }

    return sendSuccess(res, {
      user: updatedUser[0],
      business: updatedBusiness
    }, 200);
  } catch (err) {
    console.error('[UpdateUserProfile Error]:', err);
    return sendError(res, 'Failed updating profile', 'INTERNAL_ERROR', 500);
  }
}

/**
 * POST /api/v1/auth/avatar
 * Uploads user profile photo directly to Cloudinary and saves URL in database
 */
export async function uploadUserAvatar(req, res) {
  const userId = req.userId;
  if (!req.file) {
    return sendError(res, 'No photo file uploaded for avatar', 'FILE_REQUIRED', 400);
  }

  try {
    const uploadResult = await storageService.saveFile(req.file, 'avatars', true);
    const avatarUrl = uploadResult.secureUrl || uploadResult.filePath;

    await pool.query(
      'UPDATE users SET avatar_url = ?, updated_at = NOW() WHERE id = ?',
      [avatarUrl, userId]
    );

    const [users] = await pool.query(
      `SELECT id, email, full_name, avatar_url, account_type, phone, country_code, default_currency, 
              active_persona, is_id_verified, phone_verified_at, 
              is_biometric_verified, biometric_confidence, biometric_verified_at,
              nin_hash, kyc_tier, created_at 
       FROM users WHERE id = ?`,
      [userId]
    );

    return sendSuccess(res, {
      avatar_url: avatarUrl,
      user: users[0]
    }, 200, { message: 'Profile photo uploaded to Cloudinary successfully' });
  } catch (err) {
    console.error('[UploadUserAvatar Error]:', err);
    return sendError(res, err.message || 'Failed uploading avatar', err.code || 'CLOUDINARY_UPLOAD_ERROR', err.status || 500);
  }
}

/**
 * DELETE /api/v1/auth/avatar
 * Removes user profile photo and clears avatar_url
 */
export async function removeUserAvatar(req, res) {
  const userId = req.userId;
  try {
    await pool.query(
      'UPDATE users SET avatar_url = NULL, updated_at = NOW() WHERE id = ?',
      [userId]
    );

    const [users] = await pool.query(
      `SELECT id, email, full_name, avatar_url, account_type, phone, country_code, default_currency, 
              active_persona, is_id_verified, phone_verified_at, 
              is_biometric_verified, biometric_confidence, biometric_verified_at,
              nin_hash, kyc_tier, created_at 
       FROM users WHERE id = ?`,
      [userId]
    );

    return sendSuccess(res, {
      avatar_url: null,
      user: users[0]
    }, 200, { message: 'Profile photo removed successfully' });
  } catch (err) {
    console.error('[RemoveUserAvatar Error]:', err);
    return sendError(res, 'Failed removing profile photo', 'INTERNAL_ERROR', 500);
  }
}
