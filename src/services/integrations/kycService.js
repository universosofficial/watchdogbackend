import crypto from 'crypto';
import pool from '../../config/db.js';
import ActivityService from '../activityService.js';

class KycService {
  /**
   * Calculates string similarity score (0.0 to 1.0) using token intersection and Levenshtein distance
   */
  static calculateNameSimilarity(str1, str2) {
    if (!str1 || !str2) return 0.0;
    const s1 = str1.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim().replace(/\s+/g, ' ');
    const s2 = str2.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim().replace(/\s+/g, ' ');

    if (s1 === s2) return 1.0;
    if (s1.includes(s2) || s2.includes(s1)) return 0.95;

    // Token set overlap
    const tokens1 = new Set(s1.split(' ').filter(t => t.length > 1));
    const tokens2 = new Set(s2.split(' ').filter(t => t.length > 1));
    let intersection = 0;
    for (const t of tokens1) {
      if (tokens2.has(t)) intersection++;
    }

    if (tokens1.size > 0 && tokens2.size > 0) {
      const tokenScore = (2 * intersection) / (tokens1.size + tokens2.size);
      if (tokenScore >= 0.85) return tokenScore;
    }

    // Levenshtein Matrix
    const matrix = Array(s2.length + 1).fill(null).map(() => Array(s1.length + 1).fill(null));
    for (let i = 0; i <= s1.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= s2.length; j++) matrix[j][0] = j;

    for (let j = 1; j <= s2.length; j++) {
      for (let i = 1; i <= s1.length; i++) {
        const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j][i - 1] + 1,
          matrix[j - 1][i] + 1,
          matrix[j - 1][i - 1] + cost
        );
      }
    }

    const dist = matrix[s2.length][s1.length];
    const maxLen = Math.max(s1.length, s2.length);
    return Math.max(0, 1 - dist / maxLen);
  }

  /**
   * National Identification Number (NIN) Verification
   * NDPA Compliant: Raw NIN is never stored plaintext in database; only SHA-256 hash is persisted.
   */
  static async verifyNin({ nin, dob, userId, businessId, expectedFullName }) {
    const cleanedNin = (nin || '').replace(/[\s\-]/g, '').trim();

    if (!/^\d{11}$/.test(cleanedNin)) {
      const err = new Error('National Identification Number (NIN) must be exactly 11 digits');
      err.code = 'INVALID_NIN_FORMAT';
      err.status = 400;
      throw err;
    }

    // SHA-256 hash for NDPA-compliant storage and deduplication
    const ninHash = crypto.createHash('sha256').update(cleanedNin).digest('hex');

    // Check deduplication
    const [existing] = await pool.query(
      'SELECT id, email, full_name FROM users WHERE nin_hash = ? AND id != ?',
      [ninHash, userId]
    );

    if (existing.length > 0) {
      const err = new Error('This NIN has already been linked and verified by another user account');
      err.code = 'NIN_ALREADY_LINKED';
      err.status = 400;
      throw err;
    }

    const isMock = process.env.USE_KYC_MOCK !== 'false';
    const baseUrl = process.env.KYC_PROVIDER_BASE_URL || 'https://api.cheapersolution.ng/v1';
    const apiKey = process.env.KYC_PROVIDER_API_KEY || 'mock_key';

    let kycResponse;
    const logId = crypto.randomUUID();
    const reference = 'NIN-VERIF-' + Date.now() + '-' + crypto.randomInt(1000, 9999);

    if (isMock || apiKey.includes('mock')) {
      // Realistic simulation based on user's name
      const nameParts = (expectedFullName || 'Ibrahim Chukwuma').split(' ');
      const firstname = nameParts[0] || 'Ibrahim';
      const surname = nameParts.length > 1 ? nameParts[nameParts.length - 1] : 'Chukwuma';
      const middlename = nameParts.length > 2 ? nameParts[1] : '';

      kycResponse = {
        status: 'success',
        reference: reference,
        data: {
          nin_masked: cleanedNin.substring(0, 3) + '*****' + cleanedNin.substring(8),
          firstname: firstname,
          surname: surname,
          middlename: middlename,
          birthdate: dob || '1985-06-15',
          gender: 'M',
          telephoneno: '+2348011112222',
          residence_state: 'Lagos'
        }
      };
    } else {
      try {
        const apiRes = await fetch(`${baseUrl}/identity/nin`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({ nin: cleanedNin, dob })
        });
        kycResponse = await apiRes.json();
      } catch (err) {
        console.error('[CheaperSolution NIN API Exception]:', err.message);
        throw new Error('Identity verification gateway is currently unreachable. Please try again shortly.');
      }
    }

    const returnedData = kycResponse.data || {};
    const returnedFullName = `${returnedData.firstname || ''} ${returnedData.middlename || ''} ${returnedData.surname || ''}`.trim();
    const matchScore = this.calculateNameSimilarity(expectedFullName, returnedFullName);
    const confidencePercent = Math.round(matchScore * 100);

    // Cross-check returned name with registered name (threshold 85%)
    if (matchScore < 0.85) {
      // Record failure audit log
      await pool.query(
        `INSERT INTO verification_logs (
          id, business_id, user_id, verification_type, provider, status, response_reference, metadata_json, created_at
        ) VALUES (?, ?, ?, 'nin', 'cheapersolution', 'mismatch', ?, ?, NOW())`,
        [
          logId,
          businessId || null,
          userId,
          reference,
          JSON.stringify({
            expected_name: expectedFullName,
            returned_name: returnedFullName,
            confidence_score: confidencePercent,
            reason: 'Confidence score below required 85% threshold'
          })
        ]
      );

      const err = new Error(`NIN name matching confidence score (${confidencePercent}%) is below the minimum required 85%. Registered name does not match NIN records.`);
      err.code = 'NIN_NAME_MISMATCH';
      err.status = 400;
      throw err;
    }

    // Success: Record audit log with redacted metadata (no raw plaintext NIN stored)
    await pool.query(
      `INSERT INTO verification_logs (
        id, business_id, user_id, verification_type, provider, status, response_reference, metadata_json, created_at
      ) VALUES (?, ?, ?, 'nin', 'cheapersolution', 'success', ?, ?, NOW())`,
      [
        logId,
        businessId || null,
        userId,
        reference,
        JSON.stringify({
          confidence_score: confidencePercent,
          nin_masked: returnedData.nin_masked,
          registered_name: expectedFullName,
          verified_name: returnedFullName,
          dob_matched: !!dob,
          verified_at: new Date().toISOString()
        })
      ]
    );

    // Upgrade user to Tier 2 (or maintain Tier 3 if already Tier 3)
    await pool.query(
      `UPDATE users 
       SET nin_hash = ?, 
           kyc_tier = CASE WHEN kyc_tier = 'tier_3' THEN 'tier_3' ELSE 'tier_2' END 
       WHERE id = ?`,
      [ninHash, userId]
    );

    // If user's active business is currently tier_1, upgrade business to tier_2
    // If user is an Individual, elevate verification_status to 'verified'
    if (businessId) {
      await pool.query(
        `UPDATE businesses 
         SET business_tier = CASE WHEN business_tier = 'tier_3' THEN 'tier_3' ELSE 'tier_2' END,
             verification_status = CASE WHEN entity_type = 'individual' THEN 'verified' ELSE verification_status END
         WHERE id = ?`,
        [businessId]
      );
    }

    return {
      success: true,
      message: 'NIN successfully verified. Account upgraded to Tier 2 (Director Identity Verified).',
      tier: 'tier_2',
      confidence_score: confidencePercent,
      verified_name: returnedFullName,
      reference: reference
    };
  }

  /**
   * Corporate Affairs Commission (CAC) RC/BN Verification
   */
  static async verifyCac({ rcNumber, companyType = 'RC', businessId, userId, expectedBusinessName }) {
    const cleanedRc = (rcNumber || '').replace(/[\s]/g, '').trim().toUpperCase();

    if (!cleanedRc || cleanedRc.length < 5) {
      const err = new Error('Corporate Affairs Commission (CAC) registration number is invalid');
      err.code = 'INVALID_RC_FORMAT';
      err.status = 400;
      throw err;
    }

    const isMock = process.env.USE_KYC_MOCK !== 'false';
    const baseUrl = process.env.KYC_PROVIDER_BASE_URL || 'https://api.cheapersolution.ng/v1';
    const apiKey = process.env.KYC_PROVIDER_API_KEY || 'mock_key';

    let cacResponse;
    const logId = crypto.randomUUID();
    const reference = 'CAC-VERIF-' + Date.now() + '-' + crypto.randomInt(1000, 9999);

    if (isMock || apiKey.includes('mock')) {
      cacResponse = {
        status: 'success',
        reference: reference,
        data: {
          rc_number: cleanedRc,
          company_name: expectedBusinessName || 'Alpha Supplies Nigeria Ltd',
          company_status: 'ACTIVE',
          company_type: companyType,
          registration_date: '2019-03-24',
          head_office_address: '14 Commercial Avenue, Victoria Island, Lagos'
        }
      };
    } else {
      try {
        const apiRes = await fetch(`${baseUrl}/business/cac`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({ rc_number: cleanedRc, company_type: companyType })
        });
        cacResponse = await apiRes.json();
      } catch (err) {
        console.error('[CheaperSolution CAC API Exception]:', err.message);
        throw new Error('Corporate registry gateway is currently unreachable. Please try again shortly.');
      }
    }

    const companyData = cacResponse.data || {};
    const legalStatus = (companyData.company_status || '').toUpperCase();

    if (legalStatus !== 'ACTIVE') {
      await pool.query(
        `INSERT INTO verification_logs (
          id, business_id, user_id, verification_type, provider, status, response_reference, metadata_json, created_at
        ) VALUES (?, ?, ?, 'cac_rc', 'cheapersolution', 'failed', ?, ?, NOW())`,
        [
          logId,
          businessId,
          userId,
          reference,
          JSON.stringify({
            rc_number: cleanedRc,
            status: legalStatus,
            reason: 'Company registration status is not ACTIVE'
          })
        ]
      );

      const err = new Error(`CAC verification failed: Company status in federal registry is '${legalStatus}'. Only ACTIVE entities can be verified.`);
      err.code = 'CAC_INACTIVE_STATUS';
      err.status = 400;
      throw err;
    }

    const matchScore = this.calculateNameSimilarity(expectedBusinessName, companyData.company_name);
    const confidencePercent = Math.round(matchScore * 100);

    if (matchScore < 0.75) {
      await pool.query(
        `INSERT INTO verification_logs (
          id, business_id, user_id, verification_type, provider, status, response_reference, metadata_json, created_at
        ) VALUES (?, ?, ?, 'cac_rc', 'cheapersolution', 'mismatch', ?, ?, NOW())`,
        [
          logId,
          businessId,
          userId,
          reference,
          JSON.stringify({
            expected_name: expectedBusinessName,
            registered_cac_name: companyData.company_name,
            confidence_score: confidencePercent,
            reason: 'Company name similarity below 75% threshold'
          })
        ]
      );

      const err = new Error(`CAC company name mismatch: Registered name in CAC records ('${companyData.company_name}') does not match trade profile ('${expectedBusinessName}').`);
      err.code = 'CAC_NAME_MISMATCH';
      err.status = 400;
      throw err;
    }

    // Success: Log audit record
    await pool.query(
      `INSERT INTO verification_logs (
        id, business_id, user_id, verification_type, provider, status, response_reference, metadata_json, created_at
      ) VALUES (?, ?, ?, 'cac_rc', 'cheapersolution', 'success', ?, ?, NOW())`,
      [
        logId,
        businessId,
        userId,
        reference,
        JSON.stringify({
          rc_number: cleanedRc,
          registered_cac_name: companyData.company_name,
          registration_date: companyData.registration_date,
          status: 'ACTIVE',
          confidence_score: confidencePercent
        })
      ]
    );

    // Upgrade business to Tier 3 & mark CAC verified
    await pool.query(
      `UPDATE businesses 
       SET rc_number = ?, 
           cac_status = 'verified', 
           cac_verified_at = NOW(), 
           verification_status = 'verified', 
           business_tier = 'tier_3' 
       WHERE id = ?`,
      [cleanedRc, businessId]
    );

    return {
      success: true,
      message: 'CAC corporate registration verified. Enterprise upgraded to Tier 3 (Audited Enterprise Ceiling).',
      tier: 'tier_3',
      rc_number: cleanedRc,
      company_name: companyData.company_name,
      status: 'ACTIVE'
    };
  }

  /**
   * Retrieves current tiered status and transaction threshold limits based on Bank Anchor & Biometrics
   */
  static async getStatus(userId, businessId) {
    const [userRows] = await pool.query(
      'SELECT id, full_name, email, account_type, phone, phone_verified_at, is_biometric_verified, biometric_confidence, biometric_verified_at, kyc_tier FROM users WHERE id = ?',
      [userId]
    );

    let businessData = null;
    if (businessId) {
      const [bizRows] = await pool.query(
        'SELECT id, name, entity_type, rc_number, bank_name, bank_code, verified_account_number, verified_account_name, is_bank_verified, bank_verified_at, is_biometric_verified, trust_score, trust_status, business_tier FROM businesses WHERE id = ?',
        [businessId]
      );
      if (bizRows.length > 0) businessData = bizRows[0];
    }

    const user = userRows[0] || {};
    const accountType = user.account_type || 'corporate';
    const isIndividual = accountType === 'individual';

    const isPhoneVerified = !!user.phone_verified_at;
    const isBiometricVerified = Boolean(user.is_biometric_verified || businessData?.is_biometric_verified);
    const isBankVerified = Boolean(businessData?.is_bank_verified);
    const isComplete = isBankVerified && isBiometricVerified;

    let computedTier = 'tier_1';
    if (isComplete) {
      computedTier = 'tier_3';
    } else if (isBankVerified || isBiometricVerified) {
      computedTier = 'tier_2';
    }

    const checklist = {
      account_type: accountType,
      phone_verified: isPhoneVerified,
      biometric_verified: isBiometricVerified,
      bank_verified: isBankVerified,
      is_complete: isComplete,
      required_step: !isBiometricVerified ? 1 : (!isBankVerified ? 2 : 0)
    };

    // Define tier specifications
    const tierThresholds = {
      tier_1: {
        name: 'Tier 1: Basic Phone',
        max_deal_amount: 500000,
        max_deal_amount_label: '₦500,000',
        currency: 'NGN',
        badge: 'TIER 1: BASIC',
        description: 'Verified mobile phone. Complete 3D face scan or anchor your settlement bank account to unlock higher volume.',
        is_unlocked: true
      },
      tier_2: {
        name: 'Tier 2: Single-Anchor Verified',
        max_deal_amount: 5000000,
        max_deal_amount_label: '₦5,000,000',
        currency: 'NGN',
        badge: 'TIER 2: ANCHORED ✓',
        description: isBankVerified 
          ? 'Settlement bank account verified and locked. Deals up to ₦5,000,000.'
          : '3D biometric facial liveness verified. Deals up to ₦5,000,000.',
        is_unlocked: computedTier === 'tier_2' || computedTier === 'tier_3'
      },
      tier_3: {
        name: 'Tier 3: Dual-Anchor Enterprise',
        max_deal_amount: null,
        max_deal_amount_label: 'Unlimited',
        currency: 'NGN',
        badge: 'TIER 3: DUAL ANCHOR CERTIFIED ✓',
        description: 'Both Central Bank NUBAN account and 3D facial biometrics verified. Unlimited transaction ceiling.',
        is_unlocked: computedTier === 'tier_3'
      }
    };

    // Fetch recent audit logs from bank and biometric logs
    const [auditLogs] = await pool.query(
      `SELECT id, account_number, bank_code, resolved_name, match_score, status, is_biometric_matched, created_at 
       FROM bank_verification_logs 
       WHERE user_id = ? OR business_id = ? 
       ORDER BY created_at DESC LIMIT 5`,
      [userId, businessId || 'none']
    );

    return {
      user: {
        id: user.id,
        full_name: user.full_name,
        account_type: accountType,
        phone: user.phone,
        phone_verified: isPhoneVerified,
        is_biometric_verified: isBiometricVerified,
        biometric_confidence: user.biometric_confidence,
        biometric_verified_at: user.biometric_verified_at,
        kyc_tier: computedTier
      },
      business: businessData ? {
        id: businessData.id,
        name: businessData.name,
        entity_type: businessData.entity_type || accountType,
        bank_name: businessData.bank_name,
        bank_code: businessData.bank_code,
        verified_account_number: businessData.verified_account_number,
        verified_account_name: businessData.verified_account_name,
        is_bank_verified: isBankVerified,
        bank_verified_at: businessData.bank_verified_at,
        is_biometric_verified: isBiometricVerified,
        trust_score: businessData.trust_score,
        trust_status: businessData.trust_status,
        business_tier: computedTier
      } : null,
      account_type: accountType,
      is_verified: isBankVerified || isBiometricVerified,
      is_complete: isComplete,
      verification_checklist: checklist,
      verification_gate_message: !isComplete
        ? (!isBankVerified 
            ? 'Settlement bank account required: Anchor your commercial bank account with Central Bank resolution to lock verified payout details.'
            : 'Biometric verification recommended: Complete your 3D facial scan to unlock unlimited contract ceilings.')
        : null,
      active_tier: computedTier,
      tier_details: tierThresholds[computedTier] || tierThresholds['tier_1'],
      thresholds: tierThresholds,
      recent_verifications: auditLogs
    };
  }
}

export default KycService;
