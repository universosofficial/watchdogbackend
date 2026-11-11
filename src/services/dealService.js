import crypto from 'crypto';
import pool, { getConnection } from '../config/db.js';
import { AppError } from '../utils/response.js';
import ActivityService from './activityService.js';
import PaymentService from './paymentService.js';
import TrustRadarService from './trustRadarService.js';
import SmsService from './integrations/smsService.js';

export const DEAL_STATUSES = [
  'draft',
  'awaiting_acceptance',
  'active',
  'disputed',
  'completed',
  'cancelled',
  'terminated'
];

export const TIER_LIMITS = {
  tier_1: 500000,
  tier_2: 5000000,
  tier_3: Infinity
};

/**
 * Core Deal Lifecycle Service
 */
export class DealService {
  /**
   * Helper to generate human-readable reference number
   */
  static generateReferenceNo() {
    const year = new Date().getFullYear();
    const randomHex = crypto.randomBytes(3).toString('hex').toUpperCase();
    const randomDigits = Math.floor(1000 + Math.random() * 9000);
    return `DW-DEAL-${year}-${randomDigits}-${randomHex}`;
  }

  /**
   * Create a new draft deal and initial terms version
   */
  static async createDeal({
    creatorBusinessId,
    userId,
    title,
    description,
    amount,
    currency = 'NGN',
    termsText,
    counterpartyBusinessId = null,
    invitedEmail = null,
    counterpartyPhone = null,
    invitedPhone = null,
    expectedDeliveryDate = null,
    creatorRole = null
  }) {
    if (!title || !title.trim()) {
      throw new AppError('Deal title is required', 400, 'MISSING_TITLE');
    }

    if (amount === undefined || isNaN(amount) || Number(amount) <= 0) {
      throw new AppError('Deal amount must be a positive number', 400, 'INVALID_AMOUNT');
    }

    const effectiveTerms = (termsText && termsText.trim()) 
      ? termsText.trim() 
      : 'Standard Non-Custodial Agreement: Counterparty delivers agreed goods or services in accordance with stated timeline. Buyer settles payment off-platform via verified bank transfer and logs evidence. Seller attests payment within 24 hours of bank clearance.';

    const conn = await getConnection();
    try {
      await conn.beginTransaction();

      // 1. Identity & Persona Verification Check
      const [userRows] = await conn.query(
        'SELECT id, phone_verified_at, nin_hash, kyc_tier, account_type, active_persona, is_id_verified FROM users WHERE id = ?',
        [userId]
      );
      const user = userRows[0];
      const accountType = user?.account_type || 'individual';
      const persona = (creatorRole === 'seller' || creatorRole === 'buyer') 
        ? creatorRole 
        : (user?.active_persona || 'buyer');

      if (creatorRole && ['seller', 'buyer'].includes(creatorRole) && creatorRole !== user?.active_persona) {
        await conn.query('UPDATE users SET active_persona = ?, updated_at = NOW() WHERE id = ?', [creatorRole, userId]);
      }

      const isPhoneVerified = !!user?.phone_verified_at;

      const [creatorBizRows] = await conn.query(
        'SELECT id, name, business_tier, cac_status, entity_type FROM businesses WHERE id = ?',
        [creatorBusinessId]
      );

      // ZERO-FRICTION BUYER POLICY:
      // Buyers MUST NOT be gated behind Government ID, NIN, SSN, or CAC verification. Phone OTP is sufficient.
      if (!isPhoneVerified) {
        throw new AppError(
          'Please verify your phone number via SMS OTP before initiating deals.',
          403,
          'PHONE_VERIFICATION_REQUIRED'
        );
      }

      // Sellers creating provider contracts are bound by tier verification limits
      if (persona === 'seller') {
        const isBankVerified = Boolean(creatorBizRows[0]?.is_bank_verified);
        const isBiometricVerified = Boolean(user?.is_biometric_verified || creatorBizRows[0]?.is_biometric_verified);
        const creatorTier = (isBankVerified && isBiometricVerified)
          ? 'tier_3'
          : (isBankVerified || isBiometricVerified ? 'tier_2' : (creatorBizRows[0]?.business_tier || 'tier_1'));
        const maxAllowed = TIER_LIMITS[creatorTier] || 500000;
        if (Number(amount) > maxAllowed) {
          throw new AppError(
            `Contract value (₦${Number(amount).toLocaleString()}) exceeds your Tier limit (₦${maxAllowed.toLocaleString()}). Anchor your settlement bank account or complete 3D facial verification to unlock higher contract limits.`,
            403,
            'TIER_LIMIT_EXCEEDED'
          );
        }
      }

      const dealId = crypto.randomUUID();
      const referenceNo = this.generateReferenceNo();
      const versionId = crypto.randomUUID();

      // Resolve counterparty if phone or email provided
      let resolvedCounterpartyId = counterpartyBusinessId || null;
      let normPhone = null;

      const targetPhone = counterpartyPhone || invitedPhone;
      if (targetPhone) {
        try {
          normPhone = SmsService.normalizePhoneNumber(targetPhone);
          if (!resolvedCounterpartyId) {
            const [phoneMatched] = await conn.query(
              `SELECT bm.business_id 
               FROM business_members bm 
               JOIN users u ON bm.user_id = u.id 
               WHERE u.phone = ? LIMIT 1`,
              [normPhone]
            );
            if (phoneMatched.length > 0) {
              resolvedCounterpartyId = phoneMatched[0].business_id;
            }
          }
        } catch (e) {
          // Ignore format parse error for fuzzy lookup
        }
      }

      if (!resolvedCounterpartyId && invitedEmail) {
        const [registeredCounterparts] = await conn.query(
          `SELECT bm.business_id 
           FROM business_members bm 
           JOIN users u ON bm.user_id = u.id 
           WHERE u.email = ? LIMIT 1`,
          [invitedEmail.trim().toLowerCase()]
        );
        if (registeredCounterparts.length > 0) {
          resolvedCounterpartyId = registeredCounterparts[0].business_id;
        }
      }

      // 1. Insert Deal record in 'draft' status
      await conn.query(
        `INSERT INTO deals (
          id, reference_no, creator_business_id, counterparty_business_id, invited_phone,
          title, description, amount, currency, status, current_version,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, NOW(), NOW())`,
        [
          dealId,
          referenceNo,
          creatorBusinessId,
          resolvedCounterpartyId,
          normPhone,
          title.trim(),
          description ? description.trim() : null,
          Number(amount).toFixed(2),
          currency.toUpperCase()
        ]
      );

      // 2. Insert Agreement Version 1
      await conn.query(
        `INSERT INTO agreement_versions (
          id, deal_id, version_number, terms_text, created_by_business_id, created_at
        ) VALUES (?, ?, 1, ?, ?, NOW())`,
        [versionId, dealId, effectiveTerms, creatorBusinessId]
      );

      // 3. Auto-provision Delivery Obligation if expectedDeliveryDate specified
      if (expectedDeliveryDate) {
        const obligationId = crypto.randomUUID();
        const deliveryDate = new Date(expectedDeliveryDate);
        if (!isNaN(deliveryDate.getTime())) {
          const deliveryResponsible = persona === 'seller'
            ? creatorBusinessId
            : (resolvedCounterpartyId || creatorBusinessId);
          const deliveryTitle = persona === 'seller'
            ? 'Seller Delivery of Goods/Services'
            : 'Counterparty Goods/Services Fulfillment';
          await conn.query(
            `INSERT INTO obligations (
              id, deal_id, title, description, responsible_business_id,
              type, due_date, status, completion_date, created_at, updated_at
            ) VALUES (?, ?, ?, 'Contractual fulfillment of agreed deliverables within scheduled timeline', ?, 'delivery', ?, 'not_started', NULL, NOW(), NOW())`,
            [
              obligationId,
              dealId,
              deliveryTitle,
              deliveryResponsible,
              deliveryDate.toISOString().slice(0, 19).replace('T', ' ')
            ]
          );
        }
      }

      // 4. Optional Invitation Creation
      let invitation = null;
      if ((invitedEmail && invitedEmail.trim()) || normPhone) {
        const inviteId = crypto.randomUUID();
        const inviteToken = crypto.randomBytes(32).toString('hex');
        const normalizedEmail = invitedEmail ? invitedEmail.trim().toLowerCase() : null;

        await conn.query(
          `INSERT INTO deal_invitations (
            id, deal_id, invited_email, invited_phone, token, status, expires_at, created_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', DATE_ADD(NOW(), INTERVAL 7 DAY), NOW())`,
          [inviteId, dealId, normalizedEmail, normPhone, inviteToken]
        );

        invitation = {
          id: inviteId,
          invited_email: normalizedEmail,
          invited_phone: normPhone,
          token: inviteToken,
          status: 'pending',
          expires_in_days: 7
        };
      }

      // 4. Log Immutable Activity Events
      await ActivityService.logEvent(
        dealId,
        userId,
        creatorBusinessId,
        'deal.created',
        {
          reference_no: referenceNo,
          title: title.trim(),
          amount: Number(amount),
          currency: currency.toUpperCase(),
          initial_version: 1,
          has_counterparty: !!counterpartyBusinessId,
          invited_email: invitedEmail || null
        },
        conn
      );

      if (invitation) {
        await ActivityService.logEvent(
          dealId,
          userId,
          creatorBusinessId,
          'deal.invitation_sent',
          {
            invited_email: invitation.invited_email,
            token_preview: invitation.token.substring(0, 10) + '...'
          },
          conn
        );
      }

      await conn.commit();




      return {
        id: dealId,
        reference_no: referenceNo,
        title: title.trim(),
        description: description ? description.trim() : null,
        amount: Number(amount),
        currency: currency.toUpperCase(),
        status: 'draft',
        current_version: 1,
        agreement_version: {
          id: versionId,
          version_number: 1,
          terms_text: effectiveTerms,
          created_by_business_id: creatorBusinessId
        },
        invitation
      };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * List deals where caller is creator or counterparty with pagination & status filter
   */
  static async listDeals({ businessId, page = 1, limit = 10, status = null }) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 10));
    const offset = (pageNum - 1) * limitNum;

    const whereConditions = ['(d.creator_business_id = ? OR d.counterparty_business_id = ?)'];
    const queryParams = [businessId, businessId];

    if (status && DEAL_STATUSES.includes(status)) {
      whereConditions.push('d.status = ?');
      queryParams.push(status);
    }

    const whereClause = whereConditions.join(' AND ');

    // Count total matching deals
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM deals d WHERE ${whereClause}`,
      queryParams
    );
    const total = countRows[0].total;

    // Fetch paginated results
    const [deals] = await pool.query(
      `SELECT 
        d.id,
        d.reference_no,
        d.title,
        d.description,
        d.amount,
        d.currency,
        d.status,
        d.current_version,
        d.created_at,
        d.updated_at,
        b1.id AS creator_business_id,
        b1.name AS creator_business_name,
        b2.id AS counterparty_business_id,
        b2.name AS counterparty_business_name,
        CASE 
          WHEN d.creator_business_id = ? THEN 'creator'
          ELSE 'counterparty'
        END AS caller_role
      FROM deals d
      LEFT JOIN businesses b1 ON d.creator_business_id = b1.id
      LEFT JOIN businesses b2 ON d.counterparty_business_id = b2.id
      WHERE ${whereClause}
      ORDER BY d.created_at DESC
      LIMIT ? OFFSET ?`,
      [businessId, ...queryParams, limitNum, offset]
    );

    return {
      count: total,
      total,
      page: pageNum,
      limit: limitNum,
      total_pages: Math.ceil(total / limitNum),
      deals
    };
  }

  /**
   * Fetch complete deal details, current version, acceptances, and participants
   */
  static async getDealDetails(dealId, businessId) {
    const [deals] = await pool.query(
      `SELECT 
        d.id,
        d.reference_no,
        d.title,
        d.description,
        d.amount,
        d.currency,
        d.status,
        d.current_version,
        d.created_at,
        d.updated_at,
        b1.id AS creator_business_id,
        b1.name AS creator_business_name,
        b1.rc_number AS creator_rc_number,
        b1.verification_status AS creator_verification_status,
        b1.business_tier AS creator_business_tier,
        b1.cac_status AS creator_cac_status,
        b1.bank_name AS creator_bank_name,
        b1.bank_code AS creator_bank_code,
        b1.verified_account_number AS creator_verified_account_number,
        b1.verified_account_name AS creator_verified_account_name,
        b1.is_bank_verified AS creator_is_bank_verified,
        b1.is_biometric_verified AS creator_is_biometric_verified,
        u1.phone AS creator_phone,
        b2.id AS counterparty_business_id,
        b2.name AS counterparty_business_name,
        b2.rc_number AS counterparty_rc_number,
        b2.verification_status AS counterparty_verification_status,
        b2.business_tier AS counterparty_business_tier,
        b2.cac_status AS counterparty_cac_status,
        b2.bank_name AS counterparty_bank_name,
        b2.bank_code AS counterparty_bank_code,
        b2.verified_account_number AS counterparty_verified_account_number,
        b2.verified_account_name AS counterparty_verified_account_name,
        b2.is_bank_verified AS counterparty_is_bank_verified,
        b2.is_biometric_verified AS counterparty_is_biometric_verified,
        u2.phone AS counterparty_phone
      FROM deals d
      LEFT JOIN businesses b1 ON d.creator_business_id = b1.id
      LEFT JOIN business_members bm1 ON bm1.business_id = b1.id AND bm1.role = 'owner'
      LEFT JOIN users u1 ON bm1.user_id = u1.id
      LEFT JOIN businesses b2 ON d.counterparty_business_id = b2.id
      LEFT JOIN business_members bm2 ON bm2.business_id = b2.id AND bm2.role = 'owner'
      LEFT JOIN users u2 ON bm2.user_id = u2.id
      WHERE d.id = ?`,
      [dealId]
    );

    if (deals.length === 0) {
      throw new AppError('Deal not found', 404, 'DEAL_NOT_FOUND');
    }

    let deal = deals[0];
    const callerRole = businessId === deal.creator_business_id ? 'creator' : 'counterparty';

    // Fetch all agreement versions for this deal
    const [allVersions] = await pool.query(
      `SELECT 
        av.id,
        av.version_number,
        av.terms_text,
        av.created_by_business_id,
        av.created_at,
        b.name AS created_by_business_name
      FROM agreement_versions av
      LEFT JOIN businesses b ON av.created_by_business_id = b.id
      WHERE av.deal_id = ?
      ORDER BY av.version_number DESC`,
      [dealId]
    );

    const currentVersion = allVersions.find(v => v.version_number === deal.current_version) || allVersions[0] || null;

    // Fetch acceptances for current version
    let acceptances = [];
    let creatorAccepted = false;
    let counterpartyAccepted = false;

    if (currentVersion) {
      const [accRows] = await pool.query(
        `SELECT 
          aa.id,
          aa.business_id,
          aa.user_id,
          aa.accepted_at,
          aa.ip_address,
          u.full_name AS user_name,
          u.email AS user_email,
          b.name AS business_name
        FROM agreement_acceptances aa
        LEFT JOIN users u ON aa.user_id = u.id
        LEFT JOIN businesses b ON aa.business_id = b.id
        WHERE aa.version_id = ?`,
        [currentVersion.id]
      );

      acceptances = accRows;
      creatorAccepted = accRows.some(a => a.business_id === deal.creator_business_id);
      counterpartyAccepted = deal.counterparty_business_id
        ? accRows.some(a => a.business_id === deal.counterparty_business_id)
        : false;
    }

    // Fetch active/pending invitations
    const [invitations] = await pool.query(
      `SELECT id, invited_email, token, status, expires_at, created_at
       FROM deal_invitations
       WHERE deal_id = ?
       ORDER BY created_at DESC`,
      [dealId]
    );

    // Fetch obligations
    const [obligations] = await pool.query(
      'SELECT * FROM obligations WHERE deal_id = ? ORDER BY due_date ASC',
      [dealId]
    );

    // Fetch payments
    const [paymentRows] = await pool.query(
      `SELECT p.*, e.file_name AS evidence_file_name, e.mime_type AS evidence_mime_type, e.file_size AS evidence_file_size
       FROM payment_records p
       LEFT JOIN evidence_records e ON p.evidence_id = e.id
       WHERE p.deal_id = ?
       ORDER BY p.created_at DESC`,
      [dealId]
    );

    const payments = paymentRows.map(p => ({
      ...p,
      receiptUrl: p.evidence_id ? `/api/v1/deals/${dealId}/evidence/${p.evidence_id}/download` : null
    }));

    // Fetch deliveries / waybills
    const [deliveryRows] = await pool.query(
      `SELECT d.*, e.file_name AS evidence_file_name, e.mime_type AS evidence_mime_type, e.file_size AS evidence_file_size
       FROM delivery_records d
       LEFT JOIN evidence_records e ON d.evidence_id = e.id
       WHERE d.deal_id = ?
       ORDER BY d.created_at DESC`,
      [dealId]
    );

    const deliveries = deliveryRows.map(d => ({
      ...d,
      waybillPhotoUrl: d.evidence_id ? `/api/v1/deals/${dealId}/evidence/${d.evidence_id}/download` : null
    }));

    // Fetch disputes
    const [disputes] = await pool.query(
      'SELECT * FROM disputes WHERE deal_id = ? ORDER BY created_at DESC',
      [dealId]
    );

    // Fetch evidence records (including pre-payment baseline proof)
    const [evidenceRows] = await pool.query(
      `SELECT id, obligation_id, submitted_by_business_id, file_name, file_size, mime_type, verification_tier, notes, created_at
       FROM evidence_records
       WHERE deal_id = ?
       ORDER BY created_at ASC`,
      [dealId]
    );

    const evidence = evidenceRows.map(e => ({
      ...e,
      preview_url: `/api/v1/deals/${dealId}/evidence/${e.id}/download`
    }));

    // Determine seller/beneficiary banking anchor
    const sellerParty = deal.counterparty_is_bank_verified
      ? {
          isBankVerified: true,
          bankName: deal.counterparty_bank_name,
          bankCode: deal.counterparty_bank_code,
          accountNumber: deal.counterparty_verified_account_number,
          verifiedBeneficiary: deal.counterparty_verified_account_name,
          warning: 'Transfer funds ONLY to this verified beneficiary. Paying any other account violates transaction terms.'
        }
      : (deal.creator_is_bank_verified
          ? {
              isBankVerified: true,
              bankName: deal.creator_bank_name,
              bankCode: deal.creator_bank_code,
              accountNumber: deal.creator_verified_account_number,
              verifiedBeneficiary: deal.creator_verified_account_name,
              warning: 'Transfer funds ONLY to this verified beneficiary. Paying any other account violates transaction terms.'
            }
          : {
              isBankVerified: false,
              bankName: deal.counterparty_bank_name || deal.creator_bank_name || 'Unanchored Account',
              bankCode: deal.counterparty_bank_code || deal.creator_bank_code || null,
              accountNumber: deal.counterparty_verified_account_number || deal.creator_verified_account_number || null,
              verifiedBeneficiary: deal.counterparty_verified_account_name || deal.creator_verified_account_name || null,
              warning: '⚠️ UNANCHORED BENEFICIARY: The seller has not yet anchored their verified NUBAN bank account with Central Bank/NIBSS. Settle cautiously.'
            });

    return {
      deal: {
        id: deal.id,
        reference_no: deal.reference_no,
        title: deal.title,
        description: deal.description,
        amount: deal.amount,
        currency: deal.currency,
        status: deal.status,
        current_version: deal.current_version,
        created_at: deal.created_at,
        updated_at: deal.updated_at
      },
      settlementDetails: sellerParty,
      settlement_details: sellerParty,
      access_role: callerRole,
      participants: {
        creator: {
          id: deal.creator_business_id,
          name: deal.creator_business_name,
          phone: deal.creator_phone,
          rc_number: deal.creator_rc_number,
          verification_status: deal.creator_verification_status,
          business_tier: deal.creator_business_tier || 'tier_1',
          cac_status: deal.creator_cac_status || 'unverified',
          is_bank_verified: Boolean(deal.creator_is_bank_verified),
          is_biometric_verified: Boolean(deal.creator_is_biometric_verified),
          tier_badge: deal.creator_business_tier === 'tier_3'
            ? 'Dual-Anchor Verified ✓'
            : (deal.creator_business_tier === 'tier_2' ? 'Anchored Profile' : 'Basic Tier')
        },
        counterparty: deal.counterparty_business_id
          ? {
              id: deal.counterparty_business_id,
              name: deal.counterparty_business_name,
              phone: deal.counterparty_phone,
              rc_number: deal.counterparty_rc_number,
              verification_status: deal.counterparty_verification_status,
              business_tier: deal.counterparty_business_tier || 'tier_1',
              cac_status: deal.counterparty_cac_status || 'unverified',
              is_bank_verified: Boolean(deal.counterparty_is_bank_verified),
              is_biometric_verified: Boolean(deal.counterparty_is_biometric_verified),
              tier_badge: deal.counterparty_business_tier === 'tier_3'
                ? 'Dual-Anchor Verified ✓'
                : (deal.counterparty_business_tier === 'tier_2' ? 'Anchored Profile' : 'Basic Tier')
            }
          : null,
        caller_role: callerRole,
        has_unverified_party: !Boolean(deal.counterparty_is_bank_verified || deal.creator_is_bank_verified)
      },
      current_version: currentVersion,
      all_versions: allVersions,
      acceptances_status: {
        version_id: currentVersion ? currentVersion.id : null,
        version_number: deal.current_version,
        creator_accepted: creatorAccepted,
        counterparty_accepted: counterpartyAccepted,
        fully_accepted: creatorAccepted && counterpartyAccepted,
        acceptances
      },
      invitations,
      obligations,
      payments,
      deliveries,
      disputes,
      evidence
    };
  }

  /**
   * Fetch unauthenticated public preview of a deal (safe for shared WhatsApp / SMS links)
   */
  static async getPublicDealPreview(dealId) {
    const [deals] = await pool.query(
      `SELECT 
        d.id,
        d.reference_no,
        d.title,
        d.description,
        d.amount,
        d.currency,
        d.status,
        d.current_version,
        d.created_at,
        d.invited_phone,
        b1.id AS creator_business_id,
        b1.name AS creator_business_name,
        b1.verification_status AS creator_verification_status,
        b1.business_tier AS creator_business_tier,
        b1.is_bank_verified AS creator_is_bank_verified,
        b1.is_biometric_verified AS creator_is_biometric_verified,
        b2.id AS counterparty_business_id,
        b2.name AS counterparty_business_name
      FROM deals d
      LEFT JOIN businesses b1 ON d.creator_business_id = b1.id
      LEFT JOIN businesses b2 ON d.counterparty_business_id = b2.id
      WHERE d.id = ? OR d.reference_no = ?`,
      [dealId, dealId]
    );

    if (deals.length === 0) {
      throw new AppError('Deal not found or link has expired', 404, 'DEAL_NOT_FOUND');
    }

    const deal = deals[0];

    // Current version terms
    const [versionRows] = await pool.query(
      `SELECT terms_text, version_number, created_at
       FROM agreement_versions
       WHERE deal_id = ?
       ORDER BY version_number DESC LIMIT 1`,
      [deal.id]
    );
    const currentVersion = versionRows[0] || null;

    // Delivery obligation if any
    const [obs] = await pool.query(
      `SELECT due_date FROM obligations WHERE deal_id = ? AND type = 'delivery' LIMIT 1`,
      [deal.id]
    );
    const expectedDeliveryDate = obs.length > 0 ? obs[0].due_date : null;

    // Fetch pre-payment item photos / evidence records
    const [evidenceRows] = await pool.query(
      `SELECT id, file_name, file_size, mime_type, notes, created_at
       FROM evidence_records
       WHERE deal_id = ?
       ORDER BY created_at ASC`,
      [deal.id]
    );

    const { generatePreSignedEvidenceUrl } = await import('../controllers/evidenceController.js');

    const evidence = evidenceRows.map(e => {
      let signedUrl = null;
      try {
        const signed = generatePreSignedEvidenceUrl(deal.id, e.id, 86400); // 24 hours valid
        signedUrl = signed.url;
      } catch (err) {
        signedUrl = `/api/v1/deals/${deal.id}/evidence/${e.id}/download`;
      }
      return {
        id: e.id,
        file_name: e.file_name,
        file_size: e.file_size,
        mime_type: e.mime_type,
        notes: e.notes,
        created_at: e.created_at,
        url: signedUrl
      };
    });

    return {
      deal: {
        id: deal.id,
        reference_no: deal.reference_no,
        title: deal.title,
        description: deal.description,
        amount: deal.amount,
        currency: deal.currency,
        status: deal.status,
        current_version: deal.current_version,
        created_at: deal.created_at,
        expected_delivery_date: expectedDeliveryDate
      },
      creator: {
        id: deal.creator_business_id,
        name: deal.creator_business_name,
        verification_status: deal.creator_verification_status,
        is_bank_verified: Boolean(deal.creator_is_bank_verified),
        is_biometric_verified: Boolean(deal.creator_is_biometric_verified),
        tier: deal.creator_business_tier || 'tier_1'
      },
      counterparty: deal.counterparty_business_name ? {
        id: deal.counterparty_business_id,
        name: deal.counterparty_business_name
      } : null,
      current_version: currentVersion,
      evidence
    };
  }

  /**
   * Update terms: Increments version, creates new agreement_version,
   * invalidates previous acceptances (new version starts with 0),
   * resets deal status to 'awaiting_acceptance'.
   */
  static async updateTerms({ dealId, businessId, userId, termsText }) {
    if (!termsText || !termsText.trim()) {
      throw new AppError('Updated terms text cannot be empty', 400, 'INVALID_TERMS');
    }

    const [deals] = await pool.query('SELECT * FROM deals WHERE id = ?', [dealId]);
    if (deals.length === 0) {
      throw new AppError('Deal not found', 404, 'DEAL_NOT_FOUND');
    }

    let deal = deals[0];

    // State transition guard
    const immutableStatuses = ['completed', 'cancelled', 'terminated'];
    if (immutableStatuses.includes(deal.status)) {
      throw new AppError(
        `Terms cannot be modified because deal is in immutable state '${deal.status}'`,
        400,
        'DEAL_LOCKED'
      );
    }

    const nextVersionNumber = deal.current_version + 1;
    const nextVersionId = crypto.randomUUID();

    const conn = await getConnection();
    try {
      await conn.beginTransaction();

      // 1. Insert new agreement version
      await conn.query(
        `INSERT INTO agreement_versions (
          id, deal_id, version_number, terms_text, created_by_business_id, created_at
        ) VALUES (?, ?, ?, ?, ?, NOW())`,
        [nextVersionId, dealId, nextVersionNumber, termsText.trim(), businessId]
      );

      // 2. Update Deal current_version and reset status to 'awaiting_acceptance'
      await conn.query(
        `UPDATE deals 
         SET current_version = ?, status = 'awaiting_acceptance', updated_at = NOW()
         WHERE id = ?`,
        [nextVersionNumber, dealId]
      );

      // 3. Log Immutable Activity Event
      await ActivityService.logEvent(
        dealId,
        userId,
        businessId,
        'terms.updated',
        {
          previous_version: deal.current_version,
          new_version: nextVersionNumber,
          new_version_id: nextVersionId,
          previous_status: deal.status,
          new_status: 'awaiting_acceptance'
        },
        conn
      );

      await conn.commit();




      return {
        deal_id: dealId,
        previous_version: deal.current_version,
        current_version: nextVersionNumber,
        status: 'awaiting_acceptance',
        version: {
          id: nextVersionId,
          version_number: nextVersionNumber,
          terms_text: termsText.trim(),
          created_by_business_id: businessId
        }
      };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * Record acceptance of the current version by the authenticated business.
   * If BOTH parties accept this version, automatically transitions deal to 'active'.
   */
  static async acceptDeal({ dealId, businessId, userId, ipAddress = null }) {
    const [deals] = await pool.query('SELECT * FROM deals WHERE id = ?', [dealId]);
    if (deals.length === 0) {
      throw new AppError('Deal not found', 404, 'DEAL_NOT_FOUND');
    }

    let deal = deals[0];

    // State transition guards
    const nonAcceptableStatuses = ['completed', 'cancelled', 'terminated', 'disputed'];
    if (nonAcceptableStatuses.includes(deal.status)) {
      throw new AppError(
        `Cannot accept deal while in '${deal.status}' status`,
        400,
        'INVALID_STATUS_FOR_ACCEPTANCE'
      );
    }

    if (!deal.counterparty_business_id) {
      throw new AppError(
        'Cannot accept terms until a counterparty business has joined the deal',
        400,
        'COUNTERPARTY_NOT_LINKED'
      );
    }

    // Verify caller business is a legitimate party
    const isCreator = deal.creator_business_id === businessId;
    const isCounterparty = deal.counterparty_business_id === businessId;

    if (!isCreator && !isCounterparty) {
      throw new AppError('Your business is not a recognized party to this deal', 403, 'FORBIDDEN');
    }

    // 1. Mandatory Identity Verification Gate Check on Acceptance (Dual-Anchor Architecture)
    const [userRows] = await pool.query(
      'SELECT id, phone_verified_at, is_biometric_verified, account_type FROM users WHERE id = ?',
      [userId]
    );
    const user = userRows[0];
    const isPhoneVerified = !!user?.phone_verified_at;

    const [callerBizRows] = await pool.query(
      'SELECT id, name, business_tier, is_bank_verified, is_biometric_verified, entity_type FROM businesses WHERE id = ?',
      [businessId]
    );
    const isBankVerified = Boolean(callerBizRows[0]?.is_bank_verified);
    const isBiometricVerified = Boolean(user?.is_biometric_verified || callerBizRows[0]?.is_biometric_verified);
    const isVerified = isPhoneVerified && (isBankVerified || isBiometricVerified);

    // ZERO-FRICTION BUYER POLICY:
    // Buyers are NEVER gated behind bank or biometric verification. Phone OTP is sufficient.
    // Gating applies strictly to Sellers accepting supply/contractor obligations.
    const isBuyerRole = (user?.active_persona === 'buyer');

    if (!isBuyerRole) {
      if (!isVerified) {
        throw new AppError(
          `Seller identity verification required: Before accepting commercial supply contracts, please anchor your settlement bank account or complete 3D facial verification in the Verification Center.`,
          403,
          'VERIFICATION_REQUIRED'
        );
      }

      // Tier Ceiling Enforcement on Acceptance for Sellers
      const callerTier = (isBankVerified && isBiometricVerified) 
        ? 'tier_3' 
        : (isBankVerified || isBiometricVerified ? 'tier_2' : (callerBizRows[0]?.business_tier || 'tier_1'));
      const maxAllowed = TIER_LIMITS[callerTier] || 500000;
      if (Number(deal.amount) > maxAllowed) {
        throw new AppError(
          `This contract amount (₦${Number(deal.amount).toLocaleString()}) exceeds your Tier limit (₦${maxAllowed.toLocaleString()}). Complete dual-anchor verification to unlock unlimited contract ceilings.`,
          403,
          'TIER_LIMIT_EXCEEDED'
        );
      }
    }

    // Fetch current agreement version
    const [versions] = await pool.query(
      'SELECT id, version_number FROM agreement_versions WHERE deal_id = ? AND version_number = ?',
      [dealId, deal.current_version]
    );

    if (versions.length === 0) {
      throw new AppError('Current agreement version row not found', 500, 'VERSION_NOT_FOUND');
    }

    const currentVersion = versions[0];
    const conn = await getConnection();

    try {
      await conn.beginTransaction();

      // Acquire exclusive row lock on the deal to prevent concurrent acceptance races
      const [lockedDeals] = await conn.query('SELECT * FROM deals WHERE id = ? FOR UPDATE', [dealId]);
      if (lockedDeals.length > 0) {
        deal = lockedDeals[0];
      }

      // Check if this business has already accepted the current version
      const [existingAcceptance] = await conn.query(
        'SELECT id FROM agreement_acceptances WHERE version_id = ? AND business_id = ?',
        [currentVersion.id, businessId]
      );

      let acceptanceId;
      if (existingAcceptance.length > 0) {
        acceptanceId = existingAcceptance[0].id;
      } else {
        acceptanceId = crypto.randomUUID();
        await conn.query(
          `INSERT INTO agreement_acceptances (
            id, version_id, business_id, user_id, accepted_at, ip_address
          ) VALUES (?, ?, ?, ?, NOW(), ?)`,
          [acceptanceId, currentVersion.id, businessId, userId, ipAddress]
        );

        // Fire deal.accepted event
        await ActivityService.logEvent(
          dealId,
          userId,
          businessId,
          'deal.accepted',
          {
            version_id: currentVersion.id,
            version_number: currentVersion.version_number,
            ip_address: ipAddress
          },
          conn
        );
      }

      // Query all acceptances for this current version to check if both parties have accepted
      const [acceptances] = await conn.query(
        'SELECT business_id FROM agreement_acceptances WHERE version_id = ?',
        [currentVersion.id]
      );

      const acceptedBusinessIds = new Set(acceptances.map(a => a.business_id));
      const hasCreatorAccepted = acceptedBusinessIds.has(deal.creator_business_id);
      const hasCounterpartyAccepted = acceptedBusinessIds.has(deal.counterparty_business_id);
      const fullyAccepted = hasCreatorAccepted && hasCounterpartyAccepted;

      let dealStatus = deal.status;

      // AUTOMATIC TRANSITION TO ACTIVE: Both businesses accepted matching version
      if (fullyAccepted && deal.status !== 'active') {
        dealStatus = 'active';
        await conn.query(
          "UPDATE deals SET status = 'active', updated_at = NOW() WHERE id = ?",
          [dealId]
        );

        // Fire deal.activated event
        await ActivityService.logEvent(
          dealId,
          userId,
          businessId,
          'deal.activated',
          {
            version_number: currentVersion.version_number,
            version_id: currentVersion.id,
            activated_at: new Date().toISOString()
          },
          conn
        );
      }

      await conn.commit();




      return {
        acceptance_id: acceptanceId,
        version_id: currentVersion.id,
        version_number: currentVersion.version_number,
        business_id: businessId,
        creator_accepted: hasCreatorAccepted,
        counterparty_accepted: hasCounterpartyAccepted,
        deal_status: dealStatus,
        activated: fullyAccepted
      };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * Simulate partner acceptance of an invitation.
   * Links counterparty business, seals agreements from both parties, and activates escrow.
   */
  static async simulatePartnerAccept({ dealId, businessId, userId }) {
    const conn = await getConnection();
    try {
      await conn.beginTransaction();

      const [deals] = await conn.query('SELECT * FROM deals WHERE id = ?', [dealId]);
      if (deals.length === 0) {
        throw new AppError('Deal not found', 404, 'DEAL_NOT_FOUND');
      }
      let deal = deals[0];

      // 1. Resolve counterparty business if not already linked
      let counterpartyBizId = deal.counterparty_business_id;
      if (!counterpartyBizId) {
        const [invites] = await conn.query(
          'SELECT invited_email FROM deal_invitations WHERE deal_id = ? ORDER BY created_at DESC LIMIT 1',
          [dealId]
        );
        if (invites.length > 0 && invites[0].invited_email) {
          const [bizMembers] = await conn.query(
            `SELECT bm.business_id 
             FROM business_members bm 
             JOIN users u ON bm.user_id = u.id 
             WHERE u.email = ? LIMIT 1`,
            [invites[0].invited_email]
          );
          if (bizMembers.length > 0) {
            counterpartyBizId = bizMembers[0].business_id;
          }
        }

        // Fallback: Pick any other business in database that isn't creator
        if (!counterpartyBizId) {
          const [otherBiz] = await conn.query(
            'SELECT id FROM businesses WHERE id != ? LIMIT 1',
            [deal.creator_business_id]
          );
          if (otherBiz.length > 0) {
            counterpartyBizId = otherBiz[0].id;
          }
        }

        if (counterpartyBizId) {
          await conn.query('UPDATE deals SET counterparty_business_id = ? WHERE id = ?', [counterpartyBizId, dealId]);
          await conn.query("UPDATE deal_invitations SET status = 'accepted' WHERE deal_id = ?", [dealId]);
        }
      }

      // 2. Fetch current version
      const [versions] = await conn.query(
        'SELECT id, version_number FROM agreement_versions WHERE deal_id = ? AND version_number = ?',
        [dealId, deal.current_version]
      );
      if (versions.length === 0) {
        throw new AppError('Current agreement version row not found', 500, 'VERSION_NOT_FOUND');
      }
      const currentVersion = versions[0];

      // 3. Record Creator acceptance if not already recorded
      const [creatorAccept] = await conn.query(
        'SELECT id FROM agreement_acceptances WHERE version_id = ? AND business_id = ?',
        [currentVersion.id, deal.creator_business_id]
      );
      if (creatorAccept.length === 0) {
        await conn.query(
          `INSERT INTO agreement_acceptances (id, version_id, business_id, user_id, accepted_at, ip_address)
           VALUES (?, ?, ?, ?, NOW(), '127.0.0.1')`,
          [crypto.randomUUID(), currentVersion.id, deal.creator_business_id, userId]
        );
      }

      // 4. Record Counterparty acceptance
      if (counterpartyBizId) {
        const [counterpartyAccept] = await conn.query(
          'SELECT id FROM agreement_acceptances WHERE version_id = ? AND business_id = ?',
          [currentVersion.id, counterpartyBizId]
        );
        if (counterpartyAccept.length === 0) {
          const [partnerUsers] = await conn.query(
            'SELECT user_id FROM business_members WHERE business_id = ? LIMIT 1',
            [counterpartyBizId]
          );
          const partnerUserId = partnerUsers.length > 0 ? partnerUsers[0].user_id : userId;

          await conn.query(
            `INSERT INTO agreement_acceptances (id, version_id, business_id, user_id, accepted_at, ip_address)
             VALUES (?, ?, ?, ?, NOW(), '127.0.0.1')`,
            [crypto.randomUUID(), currentVersion.id, counterpartyBizId, partnerUserId]
          );
        }
      }

      // 5. Transition deal to 'active'
      await conn.query("UPDATE deals SET status = 'active', updated_at = NOW() WHERE id = ?", [dealId]);

      // 6. Log Events
      await ActivityService.logEvent(
        dealId,
        userId,
        counterpartyBizId || deal.creator_business_id,
        'deal.accepted',
        {
          simulated: true,
          version_number: currentVersion.version_number,
          actor_note: 'Partner digitally accepted invitation terms'
        },
        conn
      );

      await ActivityService.logEvent(
        dealId,
        userId,
        deal.creator_business_id,
        'deal.activated',
        {
          version_number: currentVersion.version_number,
          activated_at: new Date().toISOString()
        },
        conn
      );

      // 7. Seed sample delivery & payment milestones if no obligations exist
      const [existingObligations] = await conn.query('SELECT id FROM obligations WHERE deal_id = ?', [dealId]);
      if (existingObligations.length === 0 && counterpartyBizId) {
        const ob1Id = crypto.randomUUID();
        const ob2Id = crypto.randomUUID();
        await conn.query(
          `INSERT INTO obligations (id, deal_id, title, description, responsible_business_id, type, due_date, status, created_at, updated_at)
           VALUES 
           (?, ?, 'Initial Consignment Dispatch', 'Provide signed waybill & proof of logistics dispatch', ?, 'delivery', DATE_ADD(NOW(), INTERVAL 3 DAY), 'not_started', NOW(), NOW()),
           (?, ?, 'Milestone Escrow Payment', 'Release 50% milestone tranche upon waybill verification', ?, 'payment', DATE_ADD(NOW(), INTERVAL 5 DAY), 'not_started', NOW(), NOW())`,
          [ob1Id, dealId, deal.creator_business_id, ob2Id, dealId, counterpartyBizId]
        );
      }

      await conn.commit();



      return { dealId, status: 'active', message: 'Partner invite simulated acceptance completed. Escrow active.' };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * Send or regenerate invitation token for counterparty
   */
  static async sendOrRegenerateInvitation({ dealId, businessId, userId, invitedEmail }) {
    if (!invitedEmail || !invitedEmail.trim()) {
      throw new AppError('Invited email address is required', 400, 'MISSING_EMAIL');
    }

    const [deals] = await pool.query('SELECT * FROM deals WHERE id = ?', [dealId]);
    if (deals.length === 0) {
      throw new AppError('Deal not found', 404, 'DEAL_NOT_FOUND');
    }

    let deal = deals[0];
    if (deal.creator_business_id !== businessId) {
      throw new AppError('Only the creator business can issue deal invitations', 403, 'FORBIDDEN');
    }

    const normalizedEmail = invitedEmail.trim().toLowerCase();
    const inviteId = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('hex');

    const conn = await getConnection();
    try {
      await conn.beginTransaction();

      await conn.query(
        `INSERT INTO deal_invitations (
          id, deal_id, invited_email, token, status, expires_at, created_at
        ) VALUES (?, ?, ?, ?, 'pending', DATE_ADD(NOW(), INTERVAL 7 DAY), NOW())`,
        [inviteId, dealId, normalizedEmail, token]
      );

      // If deal was draft, transition to awaiting_acceptance
      if (deal.status === 'draft') {
        await conn.query(
          "UPDATE deals SET status = 'awaiting_acceptance', updated_at = NOW() WHERE id = ?",
          [dealId]
        );
      }

      await ActivityService.logEvent(
        dealId,
        userId,
        businessId,
        'deal.invitation_sent',
        {
          invited_email: normalizedEmail,
          invitation_id: inviteId,
          expires_in_days: 7
        },
        conn
      );

      await conn.commit();




      return {
        invitation_id: inviteId,
        deal_id: dealId,
        invited_email: normalizedEmail,
        token,
        status: 'pending',
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * Counterparty accepts invitation to join the deal
   */
  static async acceptInvitation({ token, businessId, userId }) {
    if (!token) {
      throw new AppError('Invitation token is required', 400, 'MISSING_TOKEN');
    }

    const [invitations] = await pool.query(
      `SELECT di.*, d.creator_business_id, d.counterparty_business_id, d.status AS deal_status, d.title
       FROM deal_invitations di
       INNER JOIN deals d ON di.deal_id = d.id
       WHERE di.token = ?`,
      [token]
    );

    if (invitations.length === 0) {
      throw new AppError('Invitation token not found', 404, 'INVITATION_NOT_FOUND');
    }

    const invite = invitations[0];

    if (invite.status !== 'pending') {
      throw new AppError(`Invitation has already been '${invite.status}'`, 400, 'INVITATION_ALREADY_USED');
    }

    if (new Date(invite.expires_at) < new Date()) {
      throw new AppError('Invitation token has expired', 400, 'INVITATION_EXPIRED');
    }

    if (invite.creator_business_id === businessId) {
      throw new AppError('Creator business cannot accept its own counterparty invitation', 400, 'CANNOT_ACCEPT_OWN_INVITATION');
    }

    if (invite.counterparty_business_id && invite.counterparty_business_id !== businessId) {
      throw new AppError('Another counterparty business has already accepted this deal', 409, 'COUNTERPARTY_CONFLICT');
    }

    const conn = await getConnection();
    try {
      await conn.beginTransaction();

      // Update invitation status
      await conn.query(
        "UPDATE deal_invitations SET status = 'accepted' WHERE id = ?",
        [invite.id]
      );

      // Link counterparty business to deal
      await conn.query(
        `UPDATE deals 
         SET counterparty_business_id = ?, 
             status = CASE WHEN status = 'draft' THEN 'awaiting_acceptance' ELSE status END,
             updated_at = NOW()
         WHERE id = ?`,
        [businessId, invite.deal_id]
      );

      await ActivityService.logEvent(
        invite.deal_id,
        userId,
        businessId,
        'deal.invitation_accepted',
        {
          counterparty_business_id: businessId,
          invited_email: invite.invited_email
        },
        conn
      );

      await conn.commit();




      return {
        deal_id: invite.deal_id,
        status: 'accepted',
        counterparty_business_id: businessId
      };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * Explicit State Transition Guards:
   * e.g., Cannot complete deal with open disputes.
   */
  static async transitionStatus({ dealId, businessId, userId, targetStatus, reason = null }) {
    if (!DEAL_STATUSES.includes(targetStatus)) {
      throw new AppError(`Invalid deal status '${targetStatus}'`, 400, 'INVALID_TARGET_STATUS');
    }

    const [deals] = await pool.query('SELECT * FROM deals WHERE id = ?', [dealId]);
    if (deals.length === 0) {
      throw new AppError('Deal not found', 404, 'DEAL_NOT_FOUND');
    }

    let deal = deals[0];
    const currentStatus = deal.status;

    // STATE TRANSITION GUARDS
    // Guard 1: Direct transition to 'active' cannot be done manually; MUST be via dual acceptance
    if (targetStatus === 'active') {
      throw new AppError(
        "Direct transition to 'active' is forbidden. Deals automatically activate upon dual acceptance of matching terms.",
        400,
        'ACTIVATION_REQUIRES_DUAL_ACCEPTANCE'
      );
    }

    if (currentStatus === targetStatus) {
      return { deal_id: dealId, status: currentStatus, message: 'Status unchanged' };
    }

    // Guard 2: Deal Completion Invariant Enforcement
    if (targetStatus === 'completed') {
      if (currentStatus !== 'active') {
        throw new AppError(
          `Cannot complete deal from status '${currentStatus}'. Must be in 'active' status.`,
          400,
          'INVALID_STATUS_TRANSITION'
        );
      }

      // Check open disputes
      const [disputes] = await pool.query(
        `SELECT COUNT(*) AS open_disputes 
         FROM disputes 
         WHERE deal_id = ? AND status IN ('open', 'awaiting_response', 'under_review', 'resolution_proposed')`,
        [dealId]
      );

      if (disputes[0].open_disputes > 0) {
        throw new AppError(
          `Cannot complete deal: There are ${disputes[0].open_disputes} open/unresolved disputes.`,
          400,
          'OPEN_DISPUTES_EXIST'
        );
      }

      // Check obligations completed
      const [incompleteObligations] = await pool.query(
        `SELECT COUNT(*) AS incomplete_count 
         FROM obligations 
         WHERE deal_id = ? AND status != 'completed'`,
        [dealId]
      );

      if (incompleteObligations[0].incomplete_count > 0) {
        throw new AppError(
          `Cannot complete deal: There are ${incompleteObligations[0].incomplete_count} obligations still pending delivery or verification.`,
          400,
          'OBLIGATIONS_NOT_COMPLETED'
        );
      }

      // Check financial ledger off-platform reconciliation
      const paymentSummary = await PaymentService.getPaymentSummary(dealId);
      if (paymentSummary.pending_confirmation_count > 0) {
        throw new AppError(
          `Cannot complete deal: There are ${paymentSummary.pending_confirmation_count} reported payments awaiting counterparty attestation.`,
          400,
          'UNCONFIRMED_PAYMENTS_EXIST'
        );
      }

      if (paymentSummary.unreconciled_balance > 0) {
        throw new AppError(
          `Cannot complete deal: Ledger has an unreconciled balance of ${deal.currency} ${paymentSummary.unreconciled_balance.toFixed(2)}. All contractual funds must be cleared and confirmed off-platform.`,
          400,
          'UNRECONCILED_BALANCE_REMAINS'
        );
      }
    }

    // Guard 3: Immutable terminal states cannot transition to other active states
    if (['completed', 'cancelled', 'terminated'].includes(currentStatus)) {
      throw new AppError(
        `Deal is in terminal state '${currentStatus}' and cannot be transitioned to '${targetStatus}'.`,
        400,
        'TERMINAL_STATE_LOCKED'
      );
    }

    // Guard 4: Cancellation allowed only from draft or awaiting_acceptance
    if (targetStatus === 'cancelled' && !['draft', 'awaiting_acceptance'].includes(currentStatus)) {
      throw new AppError(
        `Cannot cancel deal that has reached '${currentStatus}'. Use termination for active deals.`,
        400,
        'INVALID_CANCELLATION'
      );
    }

    const conn = await getConnection();
    try {
      await conn.beginTransaction();

      // Acquire exclusive row lock on the deal
      const [deals] = await conn.query('SELECT * FROM deals WHERE id = ? FOR UPDATE', [dealId]);
      if (deals.length === 0) {
        throw new AppError('Deal not found', 404, 'DEAL_NOT_FOUND');
      }

      await conn.query(
        'UPDATE deals SET status = ?, updated_at = NOW() WHERE id = ?',
        [targetStatus, dealId]
      );

      const eventType = targetStatus === 'completed' ? 'deal.completed' : `deal.status_${targetStatus}`;
      await ActivityService.logEvent(
        dealId,
        userId,
        businessId,
        eventType,
        {
          from_status: currentStatus,
          to_status: targetStatus,
          reason: reason || null
        },
        conn
      );

      await conn.commit();

      if (targetStatus === 'completed') {
        try {
          if (deal.creator_business_id) {
            await TrustRadarService.evaluateBusinessTrust(deal.creator_business_id);
          }
          if (deal.counterparty_business_id) {
            await TrustRadarService.evaluateBusinessTrust(deal.counterparty_business_id);
          }
        } catch (e) {
          console.error('[TrustRadar Recalc Error]:', e);
        }
      }




      return {
        deal_id: dealId,
        previous_status: currentStatus,
        status: targetStatus,
        reason
      };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * Aggregate dashboard summary metrics and recent activity for authenticated business
   */
  static async getDashboardSummary(businessId) {
    // 1. Deals status counts
    const [dealCounts] = await pool.query(
      `SELECT status, COUNT(*) AS count
       FROM deals
       WHERE creator_business_id = ? OR counterparty_business_id = ?
       GROUP BY status`,
      [businessId, businessId]
    );

    let activeDeals = 0;
    let awaitingAcceptance = 0;
    let disputedDeals = 0;
    let completedDeals = 0;
    let draftDeals = 0;
    let totalDeals = 0;

    for (const row of dealCounts) {
      const c = Number(row.count) || 0;
      totalDeals += c;
      if (row.status === 'active') activeDeals = c;
      if (row.status === 'awaiting_acceptance') awaitingAcceptance = c;
      if (row.status === 'disputed') disputedDeals = c;
      if (row.status === 'completed') completedDeals = c;
      if (row.status === 'draft') draftDeals = c;
    }

    // 2. Outstanding & Overdue obligations
    const [obligationRows] = await pool.query(
      `SELECT 
         COUNT(*) AS total_obligations,
         SUM(CASE WHEN o.status != 'completed' THEN 1 ELSE 0 END) AS outstanding,
         SUM(CASE WHEN o.status != 'completed' AND o.due_date < NOW() THEN 1 ELSE 0 END) AS overdue
       FROM obligations o
       JOIN deals d ON o.deal_id = d.id
       WHERE (d.creator_business_id = ? OR d.counterparty_business_id = ?)`,
      [businessId, businessId]
    );

    const outstandingObligations = Number(obligationRows[0]?.outstanding || 0);
    const overdueObligations = Number(obligationRows[0]?.overdue || 0);

    // 3. Open disputes
    const [disputeRows] = await pool.query(
      `SELECT COUNT(*) AS open_disputes
       FROM disputes ds
       JOIN deals d ON ds.deal_id = d.id
       WHERE (d.creator_business_id = ? OR d.counterparty_business_id = ?)
         AND ds.status IN ('open', 'awaiting_response', 'under_review', 'resolution_proposed')`,
      [businessId, businessId]
    );
    const openDisputes = Number(disputeRows[0]?.open_disputes || 0);

    // 4. Recent activities
    const [recentActivities] = await pool.query(
      `SELECT 
         al.id,
         al.deal_id,
         al.actor_user_id,
         al.actor_business_id,
         al.event_type,
         al.details_json,
         al.created_at,
         u.full_name AS actor_name,
         b.name AS actor_business_name,
         d.title AS deal_title,
         d.reference_no AS deal_reference_no
       FROM activity_logs al
       JOIN deals d ON al.deal_id = d.id
       LEFT JOIN users u ON al.actor_user_id = u.id
       LEFT JOIN businesses b ON al.actor_business_id = b.id
       WHERE (d.creator_business_id = ? OR d.counterparty_business_id = ?)
       ORDER BY al.created_at DESC
       LIMIT 10`,
      [businessId, businessId]
    );

    const parsedActivities = recentActivities.map(item => ({
      ...item,
      details: typeof item.details_json === 'string' ? JSON.parse(item.details_json) : item.details_json
    }));

    return {
      metrics: {
        active_deals: activeDeals,
        awaiting_acceptance: awaitingAcceptance,
        outstanding_obligations: outstandingObligations,
        overdue_items: overdueObligations,
        open_disputes: openDisputes,
        draft_deals: draftDeals,
        completed_deals: completedDeals,
        total_deals: totalDeals
      },
      recent_activities: parsedActivities
    };
  }
}

export default DealService;
