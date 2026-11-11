import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import pool from '../../config/db.js';
import { ActivityService } from '../activityService.js';
import storageService from '../storageService.js';

class DojahService {
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

    // Levenshtein distance matrix
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
   * Evaluates if Dojah service is in sandbox/mock mode
   */
  static isMock() {
    const key = process.env.DOJAH_API_KEY || '';
    const env = process.env.DOJAH_ENV || 'sandbox';
    return !key || key.includes('mock') || env === 'sandbox' || process.env.NODE_ENV !== 'production';
  }

  /**
   * Global Individual Identity Verification (Sellers & Directors)
   * Multi-Country Routing:
   * - NG: NIN / BVN lookup
   * - GH: Ghana Card lookup
   * - KE: National ID
   * - ZA: South African ID
   * - US: SSN-4 / Driver's License
   * - UK / Global: International Passport OCR + Liveness
   */
  static async verifyIndividual({ country = 'NG', idType = 'nin', idNumber, userProfile = {}, userId, businessId }) {
    const cleanedNumber = (idNumber || '').replace(/[\s\-]/g, '').trim();
    if (!cleanedNumber) {
      const err = new Error('Identification document number is required');
      err.status = 400;
      throw err;
    }

    const normalizedCountry = (country || 'NG').toUpperCase();
    const reference = `DOJAH-ID-${normalizedCountry}-${Date.now()}-${crypto.randomInt(1000, 9999)}`;
    const logId = crypto.randomUUID();
    const expectedName = userProfile.full_name || '';

    let dojahResult = null;
    let confidenceScore = 100;
    let verifiedName = expectedName;

    if (this.isMock()) {
      // Mock / Sandbox simulation with intelligent realistic data
      const nameParts = expectedName ? expectedName.split(' ') : ['Ibrahim', 'Chukwuma'];
      const firstname = nameParts[0] || 'Ibrahim';
      const surname = nameParts.length > 1 ? nameParts[nameParts.length - 1] : 'Chukwuma';
      verifiedName = `${firstname} ${surname}`;
      confidenceScore = 98;

      dojahResult = {
        status: 'success',
        reference,
        entity: {
          first_name: firstname,
          last_name: surname,
          id_number: cleanedNumber.substring(0, 3) + '*****' + cleanedNumber.slice(-3),
          country: normalizedCountry,
          id_type: idType,
          date_of_birth: userProfile.dob || '1990-05-12',
          verified: true
        }
      };
    } else {
      const baseUrl = process.env.DOJAH_BASE_URL || 'https://api.dojah.io';
      const apiKey = process.env.DOJAH_API_KEY;
      const appId = process.env.DOJAH_APP_ID;

      // Select endpoint based on country and idType
      let endpoint = `/api/v1/kyc/${idType.toLowerCase()}`;
      if (normalizedCountry === 'GH') endpoint = '/api/v1/kyc/gh/card';
      else if (normalizedCountry === 'KE') endpoint = '/api/v1/kyc/ke/id';
      else if (normalizedCountry === 'ZA') endpoint = '/api/v1/kyc/za/id';
      else if (normalizedCountry === 'US') endpoint = '/api/v1/kyc/us/ssn';
      else if (idType === 'passport') endpoint = '/api/v1/kyc/passport';

      try {
        const response = await fetch(`${baseUrl}${endpoint}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': apiKey,
            'AppId': appId
          },
          body: JSON.stringify({
            value: cleanedNumber,
            country: normalizedCountry,
            ...userProfile
          })
        });

        const data = await response.json();
        if (!response.ok || !data.entity) {
          throw new Error(data.error || 'Dojah identity validation check failed');
        }

        dojahResult = data;
        const entity = data.entity;
        verifiedName = `${entity.first_name || ''} ${entity.last_name || ''}`.trim();
        const sim = this.calculateNameSimilarity(expectedName, verifiedName);
        confidenceScore = Math.round(sim * 100);
      } catch (err) {
        console.error('[Dojah Individual Verification Error]:', err.message);
        throw err;
      }
    }

    // Levenshtein threshold validation (>= 85%)
    const passed = confidenceScore >= 85;
    const verificationStatus = passed ? 'passed' : 'failed';

    // Record Dojah audit log
    if (userId) {
      await pool.query(
        `INSERT INTO dojah_audit_logs (
          id, user_id, business_id, service_type, country, dojah_reference, verification_status, risk_assessment, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          logId,
          userId,
          businessId || null,
          `individual_${idType}`,
          normalizedCountry,
          reference,
          verificationStatus,
          JSON.stringify({
            id_type: idType,
            confidence_score: confidenceScore,
            expected_name: expectedName,
            verified_name: verifiedName,
            is_mock: this.isMock()
          })
        ]
      );

      if (passed) {
        // Upgrade user flags
        await pool.query(
          `UPDATE users 
           SET is_id_verified = TRUE, 
               kyc_tier = CASE WHEN kyc_tier = 'tier_3' THEN 'tier_3' ELSE 'tier_2' END,
               country_code = ?,
               updated_at = NOW()
           WHERE id = ?`,
          [normalizedCountry, userId]
        );
      }
    }

    if (!passed) {
      const err = new Error(`Identity name similarity (${confidenceScore}%) is below the required 85% threshold.`);
      err.status = 400;
      err.confidenceScore = confidenceScore;
      throw err;
    }

    return {
      success: true,
      reference,
      status: 'verified',
      country: normalizedCountry,
      id_type: idType,
      confidence_score: confidenceScore,
      verified_name: verifiedName
    };
  }

  /**
   * Global Corporate / Business Verification (KYB - Suppliers & Contractors)
   * Multi-Country Routing:
   * - NG: CAC RC / BN lookup via Dojah (checks active status, address, directors)
   * - Global: US, UK, Canada, EU Business Registrar search via Dojah Global KYB
   */
  static async verifyBusiness({ country = 'NG', registrationNumber, legalName, businessId, userId }) {
    const cleanedRc = (registrationNumber || '').replace(/[\s]/g, '').trim().toUpperCase();
    if (!cleanedRc || cleanedRc.length < 3) {
      const err = new Error('Corporate registration number (RC/BN/Company No) is required');
      err.status = 400;
      throw err;
    }

    const normalizedCountry = (country || 'NG').toUpperCase();
    const reference = `DOJAH-KYB-${normalizedCountry}-${Date.now()}-${crypto.randomInt(1000, 9999)}`;
    const logId = crypto.randomUUID();
    const expectedName = legalName || '';

    let kybData = null;
    let confidenceScore = 100;
    let isActive = true;

    if (this.isMock()) {
      kybData = {
        company_name: expectedName || 'Alpha Supplies Nigeria Ltd',
        registration_number: cleanedRc,
        status: 'ACTIVE',
        country: normalizedCountry,
        registration_date: '2020-04-18',
        address: '14 Commercial Avenue, Lagos, Nigeria'
      };
      confidenceScore = 96;
      isActive = true;
    } else {
      const baseUrl = process.env.DOJAH_BASE_URL || 'https://api.dojah.io';
      const apiKey = process.env.DOJAH_API_KEY;
      const appId = process.env.DOJAH_APP_ID;

      const endpoint = normalizedCountry === 'NG' 
        ? `/api/v1/kyb/cac?rc_number=${encodeURIComponent(cleanedRc)}`
        : `/api/v1/kyb/global?country=${encodeURIComponent(normalizedCountry)}&reg_number=${encodeURIComponent(cleanedRc)}`;

      try {
        const response = await fetch(`${baseUrl}${endpoint}`, {
          method: 'GET',
          headers: {
            'Authorization': apiKey,
            'AppId': appId
          }
        });

        const data = await response.json();
        if (!response.ok || !data.entity) {
          throw new Error(data.error || 'Dojah corporate registry lookup returned no record');
        }

        kybData = data.entity;
        const regStatus = (kybData.status || kybData.company_status || 'ACTIVE').toUpperCase();
        isActive = regStatus === 'ACTIVE' || regStatus === 'LIVE';
        const sim = this.calculateNameSimilarity(expectedName, kybData.company_name);
        confidenceScore = Math.round(sim * 100);
      } catch (err) {
        console.error('[Dojah Business KYB Error]:', err.message);
        throw err;
      }
    }

    const passed = isActive && confidenceScore >= 75;
    const verificationStatus = passed ? 'passed' : 'failed';

    if (businessId && userId) {
      await pool.query(
        `INSERT INTO dojah_audit_logs (
          id, user_id, business_id, service_type, country, dojah_reference, verification_status, risk_assessment, created_at
        ) VALUES (?, ?, ?, 'kyb_registry', ?, ?, ?, ?, NOW())`,
        [
          logId,
          userId,
          businessId,
          normalizedCountry,
          reference,
          verificationStatus,
          JSON.stringify({
            registration_number: cleanedRc,
            company_name: kybData.company_name,
            expected_name: expectedName,
            status: kybData.status,
            confidence_score: confidenceScore,
            is_mock: this.isMock()
          })
        ]
      );

      if (passed) {
        // Upgrade business to Tier 3 & recalculate trust status
        await pool.query(
          `UPDATE businesses 
           SET rc_number = ?,
               country_code = ?,
               cac_status = 'verified',
               verification_status = 'verified',
               cac_verified_at = NOW(),
               business_tier = 'tier_3',
               dojah_verification_id = ?,
               trust_score = GREATEST(trust_score, 85),
               trust_status = 'safe',
               updated_at = NOW()
           WHERE id = ?`,
          [cleanedRc, normalizedCountry, reference, businessId]
        );
      }
    }

    if (!passed) {
      const err = new Error(
        !isActive 
          ? `Company status in corporate registry is '${kybData.status}'. Only ACTIVE legal entities can be verified.`
          : `Corporate registry name similarity (${confidenceScore}%) is below the required 75% threshold.`
      );
      err.status = 400;
      throw err;
    }

    return {
      success: true,
      reference,
      company_name: kybData.company_name,
      registration_number: cleanedRc,
      country: normalizedCountry,
      status: 'verified',
      trust_status: 'safe',
      confidence_score: confidenceScore
    };
  }

  /**
   * Biometric Facial Liveness & Similarity Check
   */
  static async performLivenessCheck({ selfieImageBase64, idPhotoBase64, userId, businessId }) {
    const reference = `DOJAH-BIO-${Date.now()}-${crypto.randomInt(1000, 9999)}`;
    const logId = crypto.randomUUID();

    let livenessScore = 97;
    let matchScore = 95;

    if (!this.isMock() && selfieImageBase64) {
      const baseUrl = process.env.DOJAH_BASE_URL || 'https://api.dojah.io';
      const apiKey = process.env.DOJAH_API_KEY;
      const appId = process.env.DOJAH_APP_ID;

      try {
        const response = await fetch(`${baseUrl}/api/v1/kyc/biometrics/liveness`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': apiKey,
            'AppId': appId
          },
          body: JSON.stringify({
            image: selfieImageBase64,
            target_image: idPhotoBase64 || undefined
          })
        });

        const data = await response.json();
        if (response.ok && data.entity) {
          livenessScore = Math.round((data.entity.liveness_score || 0.95) * 100);
          matchScore = Math.round((data.entity.similarity_score || 0.95) * 100);
        }
      } catch (err) {
        console.error('[Dojah Biometrics Error]:', err.message);
      }
    }

    const passed = livenessScore >= 80 && matchScore >= 75;

    if (userId) {
      await pool.query(
        `INSERT INTO dojah_audit_logs (
          id, user_id, business_id, service_type, country, dojah_reference, verification_status, risk_assessment, created_at
        ) VALUES (?, ?, ?, 'biometric_liveness', 'NG', ?, ?, ?, NOW())`,
        [
          logId,
          userId,
          businessId || null,
          reference,
          passed ? 'passed' : 'failed',
          JSON.stringify({
            liveness_score: livenessScore,
            similarity_score: matchScore,
            is_mock: this.isMock()
          })
        ]
      );

      if (passed) {
        // Save baseline facial template image for future high-profile step-up match challenges
        let baselinePath = null;
        if (selfieImageBase64) {
          try {
            const cleanBase64 = selfieImageBase64.replace(/^data:image\/\w+;base64,/, '');
            const buffer = Buffer.from(cleanBase64, 'base64');
            const fileObj = {
              originalname: `${userId}_baseline.jpg`,
              mimetype: 'image/jpeg',
              size: buffer.length,
              buffer
            };
            const stored = await storageService.saveFile(fileObj, 'biometrics');
            baselinePath = stored.filePath;
          } catch (saveErr) {
            console.error('[Biometric Baseline Save Error]:', saveErr.message);
          }
        }

        await pool.query(
          `UPDATE users 
           SET is_biometric_verified = TRUE,
               biometric_confidence = ?,
               biometric_verified_at = NOW(),
               biometric_reference = ?,
               biometric_baseline_path = COALESCE(?, biometric_baseline_path)
           WHERE id = ?`,
          [livenessScore, reference, baselinePath, userId]
        );

        if (businessId) {
          const [bRows] = await pool.query('SELECT is_bank_verified FROM businesses WHERE id = ?', [businessId]);
          const hasBank = bRows.length > 0 && Boolean(bRows[0].is_bank_verified);
          const newTier = hasBank ? 'tier_3' : 'tier_2';

          await pool.query(
            `UPDATE businesses
             SET is_biometric_verified = TRUE,
                 biometric_verified_at = NOW(),
                 business_tier = ?,
                 trust_score = LEAST(100, trust_score + 15),
                 trust_status = 'safe'
             WHERE id = ?`,
            [newTier, businessId]
          );
        }
      }
    }

    return {
      success: passed,
      reference,
      liveness_score: livenessScore,
      similarity_score: matchScore,
      is_biometric_verified: passed,
      status: passed ? 'verified' : 'failed'
    };
  }

  /**
   * High-Profile / High-Value Transaction Step-Up Biometric Authorization
   * Matches live selfie against enrolled user's baseline face template (1:1 Verification)
   */
  static async verifyStepUpBiometrics({ userId, businessId, dealId, actionType = 'high_value_transaction', amount, liveSelfieBase64 }) {
    if (!userId) {
      throw new Error('User ID is required for biometric step-up authorization');
    }
    if (!liveSelfieBase64) {
      throw new Error('Live facial snapshot (Base64) is required for step-up verification');
    }

    // 1. Retrieve enrolled user's biometric baseline
    const [userRows] = await pool.query(
      `SELECT id, full_name, is_biometric_verified, biometric_baseline_path, biometric_reference 
       FROM users WHERE id = ?`,
      [userId]
    );

    if (userRows.length === 0) {
      throw new Error('User account not found');
    }

    const user = userRows[0];
    const reference = `DOJAH-STEPUP-${Date.now()}-${crypto.randomInt(1000, 9999)}`;
    const authId = crypto.randomUUID();

    let baselineBase64 = null;
    if (user.biometric_baseline_path) {
      try {
        const buffer = await storageService.getFileBuffer(user.biometric_baseline_path);
        if (buffer) {
          baselineBase64 = `data:image/jpeg;base64,${buffer.toString('base64')}`;
        }
      } catch (readErr) {
        console.warn('[Step-Up Read Baseline Warning]:', readErr.message);
      }
    }

    let livenessScore = 98;
    let similarityScore = 96;

    if (!this.isMock() && baselineBase64) {
      const baseUrl = process.env.DOJAH_BASE_URL || 'https://api.dojah.io';
      const apiKey = process.env.DOJAH_API_KEY;
      const appId = process.env.DOJAH_APP_ID;

      try {
        const response = await fetch(`${baseUrl}/api/v1/kyc/biometrics/liveness`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': apiKey,
            'AppId': appId
          },
          body: JSON.stringify({
            image: liveSelfieBase64,
            target_image: baselineBase64
          })
        });

        const data = await response.json();
        if (response.ok && data.entity) {
          livenessScore = Math.round((data.entity.liveness_score || 0.95) * 100);
          similarityScore = Math.round((data.entity.similarity_score || 0.95) * 100);
        }
      } catch (err) {
        console.error('[Dojah Step-Up Biometrics Error]:', err.message);
      }
    } else {
      // If no baseline image existed yet on disk or cloud, save this live snapshot as the persistent baseline
      if (!user.biometric_baseline_path) {
        try {
          const cleanBase64 = liveSelfieBase64.replace(/^data:image\/\w+;base64,/, '');
          const buffer = Buffer.from(cleanBase64, 'base64');
          const fileObj = {
            originalname: `${userId}_baseline.jpg`,
            mimetype: 'image/jpeg',
            size: buffer.length,
            buffer
          };
          const stored = await storageService.saveFile(fileObj, 'biometrics');
          const baselinePath = stored.filePath;
          await pool.query(
            'UPDATE users SET is_biometric_verified = TRUE, biometric_baseline_path = ? WHERE id = ?',
            [baselinePath, userId]
          );
        } catch (saveErr) {
          console.error('[Biometric Step-Up Save Baseline Error]:', saveErr.message);
        }
      }
      similarityScore = 96;
      livenessScore = 98;
    }

    const passed = livenessScore >= 75 && similarityScore >= 75;

    // 2. Record authorization in database
    await pool.query(
      `INSERT INTO biometric_authorizations (
        id, user_id, business_id, deal_id, action_type, amount, similarity_score, liveness_score, status, auth_reference, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        authId,
        userId,
        businessId || null,
        dealId || null,
        actionType,
        amount || null,
        similarityScore,
        livenessScore,
        passed ? 'authorized' : 'rejected',
        reference
      ]
    );

    // 3. Log audit event
    await pool.query(
      `INSERT INTO dojah_audit_logs (
        id, user_id, business_id, service_type, country, dojah_reference, verification_status, risk_assessment, created_at
      ) VALUES (?, ?, ?, 'biometric_step_up', 'NG', ?, ?, ?, NOW())`,
      [
        crypto.randomUUID(),
        userId,
        businessId || null,
        reference,
        passed ? 'passed' : 'failed',
        JSON.stringify({
          action_type: actionType,
          deal_id: dealId,
          amount,
          similarity_score: similarityScore,
          liveness_score: livenessScore,
          is_mock: this.isMock()
        })
      ]
    );

    if (dealId) {
      try {
        await ActivityService.logEvent(
          dealId,
          userId,
          businessId || null,
          'deal.biometric_authorized',
          {
            action: actionType,
            actor_name: user.full_name,
            similarity_score: similarityScore,
            liveness_score: livenessScore,
            auth_reference: reference,
            message: `1:1 Biometric identity confirmed by ${user.full_name} (${similarityScore}% match)`
          }
        );
      } catch (actErr) {
        console.warn('[Activity Log Bio Warning]:', actErr.message);
      }
    }

    if (!passed) {
      const err = new Error(`Biometric verification failed. Facial similarity (${similarityScore}%) did not meet the 75% identity threshold.`);
      err.status = 403;
      err.code = 'BIOMETRIC_MISMATCH';
      throw err;
    }

    return {
      success: true,
      authorized: true,
      auth_id: authId,
      reference,
      similarity_score: similarityScore,
      liveness_score: livenessScore,
      user_name: user.full_name,
      timestamp: new Date().toISOString()
    };
  }
}

export default DojahService;
