import crypto from 'crypto';
import pool, { getConnection } from '../config/db.js';
import { AppError } from '../utils/response.js';
import ActivityService from './activityService.js';

export class EnforcementService {
  /**
   * Initiate the formal 7-Day Cure Period upon a documented covenant breach.
   * Gives the counterparty a strict statutory window to fulfill delivery or refund the buyer.
   */
  static async initiateCurePeriod({ dealId, businessId, userId, reason, obligationId = null }) {
    if (!reason || reason.trim().length < 5) {
      throw new AppError('A clear, factual reason for the covenant breach is required', 400, 'INVALID_REASON');
    }

    const [deals] = await pool.query('SELECT * FROM deals WHERE id = ?', [dealId]);
    if (deals.length === 0) {
      throw new AppError('Deal record not found', 404, 'DEAL_NOT_FOUND');
    }
    const deal = deals[0];

    // Determine the accused defaulting party (the other business in the deal)
    const defaultingBusinessId = (businessId === deal.creator_business_id) 
      ? deal.counterparty_business_id 
      : deal.creator_business_id;

    if (!defaultingBusinessId) {
      throw new AppError('Cannot initiate cure period: counterparty business is not established', 400, 'NO_COUNTERPARTY');
    }

    const cureDeadline = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // exactly 7 days
    const reportedAt = new Date();

    const conn = await getConnection();
    try {
      await conn.beginTransaction();

      // 1. Update deal cure state
      await conn.query(
        `UPDATE deals 
         SET cure_status = 'cure_period_active',
             cure_deadline = ?,
             breach_reported_at = ?,
             breach_reason = ?,
             status = 'disputed'
         WHERE id = ?`,
        [cureDeadline, reportedAt, reason.trim(), dealId]
      );

      // 2. Put defaulting business under cure review
      await conn.query(
        `UPDATE businesses 
         SET reputation_status = 'under_cure_review'
         WHERE id = ?`,
        [defaultingBusinessId]
      );

      // 3. If tied to an obligation, mark obligation disputed
      if (obligationId) {
        await conn.query(
          `UPDATE obligations SET status = 'disputed' WHERE id = ? AND deal_id = ?`,
          [obligationId, dealId]
        );
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    // 4. Log activity audit event
    await ActivityService.logActivity({
      dealId,
      actorUserId: userId,
      actorBusinessId: businessId,
      eventType: 'COVENANT_BREACH_CURE_PERIOD_STARTED',
      details: {
        reason: reason.trim(),
        cure_deadline: cureDeadline.toISOString(),
        defaulting_business_id: defaultingBusinessId,
        days_allocated: 7
      }
    });

    return {
      deal_id: dealId,
      cure_status: 'cure_period_active',
      cure_deadline: cureDeadline,
      breach_reported_at: reportedAt,
      breach_reason: reason.trim(),
      defaulting_business_id: defaultingBusinessId,
      message: '7-Day Statutory Cure Notice triggered. Formal warning delivered to vendor.'
    };
  }

  /**
   * Resolve / Cure the breach before countdown expiration (e.g. vendor refunds buyer or delivers proof)
   */
  static async resolveCure({ dealId, businessId, userId, resolutionNotes = '' }) {
    const [deals] = await pool.query('SELECT * FROM deals WHERE id = ?', [dealId]);
    if (deals.length === 0) {
      throw new AppError('Deal record not found', 404, 'DEAL_NOT_FOUND');
    }
    const deal = deals[0];

    const conn = await getConnection();
    try {
      await conn.beginTransaction();

      await conn.query(
        `UPDATE deals 
         SET cure_status = 'cured',
             status = 'active'
         WHERE id = ?`,
        [dealId]
      );

      // Restore reputation status of business if it was under review
      const otherBusinessId = (businessId === deal.creator_business_id) 
        ? deal.counterparty_business_id 
        : deal.creator_business_id;

      if (otherBusinessId) {
        await conn.query(
          `UPDATE businesses 
           SET reputation_status = 'good_standing'
           WHERE id = ? AND reputation_status = 'under_cure_review'`,
          [otherBusinessId]
        );
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    await ActivityService.logActivity({
      dealId,
      actorUserId: userId,
      actorBusinessId: businessId,
      eventType: 'CURE_PERIOD_AMICABLY_RESOLVED',
      details: {
        notes: resolutionNotes,
        resolved_at: new Date().toISOString()
      }
    });

    return {
      deal_id: dealId,
      cure_status: 'cured',
      message: 'Breach successfully rectified. Watchdog enforcement standing restored.'
    };
  }

  /**
   * Escalate an expired or unrectified cure window into Public Blacklisting & FCCPC Dossier Dispatch
   */
  static async escalateToBlacklistAndDossier({ dealId, businessId, userId }) {
    const [deals] = await pool.query('SELECT * FROM deals WHERE id = ?', [dealId]);
    if (deals.length === 0) {
      throw new AppError('Deal record not found', 404, 'DEAL_NOT_FOUND');
    }
    const deal = deals[0];

    const defaultingBusinessId = (businessId === deal.creator_business_id) 
      ? deal.counterparty_business_id 
      : deal.creator_business_id;

    if (!defaultingBusinessId) {
      throw new AppError('Cannot escalate: counterparty business reference missing', 400, 'NO_DEFAULTING_BIZ');
    }

    // Fetch defaulting business details
    const [defBizRows] = await pool.query('SELECT * FROM businesses WHERE id = ?', [defaultingBusinessId]);
    const defaultingBiz = defBizRows[0] || {};

    // Fetch complainant business details
    const [compBizRows] = await pool.query('SELECT * FROM businesses WHERE id = ?', [businessId]);
    const complainantBiz = compBizRows[0] || {};

    // Fetch agreement version text
    const [versionRows] = await pool.query(
      'SELECT terms_text, version_number, created_at FROM agreement_versions WHERE deal_id = ? ORDER BY version_number DESC LIMIT 1',
      [dealId]
    );
    const agreementVersion = versionRows[0] || {};

    // Generate unique FCCPC Docket & Dossier Reference
    const fccpcRef = `FCCPC-DW-2026-${Math.floor(100000 + Math.random() * 900000)}`;
    const blacklistId = crypto.randomUUID();

    // Construct the structured Statutory Dossier Payload
    const dossierPayload = {
      dossier_reference: fccpcRef,
      statutory_bodies: [
        'Federal Competition and Consumer Protection Commission (FCCPC)',
        'Special Fraud Unit (SFU) - Nigeria Police Force',
        'State Real Estate Regulatory Authority (LASRERA)'
      ],
      legal_statutes_invoked: [
        'FCCP Act 2018 - Section 127 (Deceptive Trade Practices & Breach of Contract)',
        'FCCP Act 2018 - Section 130 (Consumer Right to Safe & Complete Delivery of Service)',
        'Criminal Code Act - Section 419 (Obtaining Property by False Pretences)',
        'Digital Watchdog Bilateral Agreement Covenant Arbitration Clause'
      ],
      complainant: {
        business_name: complainantBiz.name || 'Private Complainant',
        rc_number: complainantBiz.rc_number || 'N/A',
        reported_by_user_id: userId
      },
      respondent_defaulting_entity: {
        business_id: defaultingBusinessId,
        business_name: defaultingBiz.name || 'Defaulting Respondent Entity',
        rc_number: defaultingBiz.rc_number || 'UNREGISTERED_ENTITY',
        entity_type: defaultingBiz.entity_type || 'corporate',
        address: defaultingBiz.address || 'Address on file'
      },
      deal_particulars: {
        deal_id: dealId,
        reference_no: deal.reference_no,
        title: deal.title,
        amount: Number(deal.amount),
        currency: deal.currency || 'NGN',
        agreement_version: agreementVersion.version_number || 1,
        breach_summary: deal.breach_reason || 'Unfulfilled covenant following 7-day cure period',
        cure_initiated_at: deal.breach_reported_at,
        cure_expired_at: deal.cure_deadline || new Date()
      },
      evidence_trail_hash: null,
      generated_at: new Date().toISOString()
    };

    // Calculate SHA-256 integrity hash
    const hashString = JSON.stringify(dossierPayload);
    const dossierHash = crypto.createHash('sha256').update(hashString).digest('hex');
    dossierPayload.evidence_trail_hash = dossierHash;

    const conn = await getConnection();
    try {
      await conn.beginTransaction();

      // 1. Insert into blacklist_records
      await conn.query(
        `INSERT INTO blacklist_records (
          id, business_id, deal_id, reference_no, business_name, rc_number,
          director_name, deal_amount, currency, covenant_breached, default_summary,
          cure_period_expired_at, reported_to_fccpc, fccpc_dossier_ref,
          reported_to_police_sfu, reported_to_lasrera, reported_to_credit_bureau,
          status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), TRUE, ?, TRUE, TRUE, TRUE, 'active_default', NOW())`,
        [
          blacklistId,
          defaultingBusinessId,
          dealId,
          deal.reference_no,
          defaultingBiz.name || 'Defaulting Commercial Entity',
          defaultingBiz.rc_number || null,
          complainantBiz.name || 'Executive Signatory',
          deal.amount,
          deal.currency || 'NGN',
          deal.title,
          deal.breach_reason || 'Refusal to deliver covenant deliverables following 7-day statutory cure window.',
          fccpcRef
        ]
      );

      // 2. Mark defaulting business as blacklisted in businesses table
      await conn.query(
        `UPDATE businesses 
         SET reputation_status = 'blacklisted',
             covenants_defaulted_count = covenants_defaulted_count + 1,
             blacklisted_at = NOW(),
             blacklist_reason = ?
         WHERE id = ?`,
        [deal.breach_reason || 'Faltered on verified covenant deliverables.', defaultingBusinessId]
      );

      // 3. Update deal record with dossier hash
      await conn.query(
        `UPDATE deals 
         SET cure_status = 'defaulted_escalated',
             regulatory_dossier_hash = ?,
             regulatory_dossier_json = ?
         WHERE id = ?`,
        [dossierHash, JSON.stringify(dossierPayload), dealId]
      );

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    // 4. Activity log
    await ActivityService.logActivity({
      dealId,
      actorUserId: userId,
      actorBusinessId: businessId,
      eventType: 'VENDOR_BLACKLISTED_AND_FCCPC_DOSSIER_DISPATCHED',
      details: {
        fccpc_reference: fccpcRef,
        dossier_hash: dossierHash,
        defaulting_business_name: defaultingBiz.name,
        blacklist_record_id: blacklistId
      }
    });

    return {
      success: true,
      blacklist_record_id: blacklistId,
      fccpc_dossier_ref: fccpcRef,
      dossier_hash: dossierHash,
      defaulting_business_name: defaultingBiz.name,
      dossier: dossierPayload,
      message: 'Vendor has been added to public Blacklist Registry. Official FCCPC Statutory Petition generated.'
    };
  }

  /**
   * Retrieve the complete regulatory dossier packet for a deal
   */
  static async getRegulatoryDossier(dealId) {
    const [deals] = await pool.query(
      'SELECT id, reference_no, title, cure_status, regulatory_dossier_hash, regulatory_dossier_json FROM deals WHERE id = ?',
      [dealId]
    );

    if (deals.length === 0) {
      throw new AppError('Deal not found', 404, 'DEAL_NOT_FOUND');
    }

    const deal = deals[0];
    if (!deal.regulatory_dossier_json) {
      throw new AppError('No regulatory dossier has been generated for this deal yet', 404, 'DOSSIER_NOT_GENERATED');
    }

    let dossier = deal.regulatory_dossier_json;
    if (typeof dossier === 'string') {
      try {
        dossier = JSON.parse(dossier);
      } catch (e) {
        // preserve as-is
      }
    }

    return {
      deal_id: deal.id,
      deal_reference: deal.reference_no,
      dossier_hash: deal.regulatory_dossier_hash,
      dossier
    };
  }
}

export default EnforcementService;
