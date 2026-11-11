import crypto from 'crypto';
import pool, { getConnection } from '../config/db.js';
import { AppError } from '../utils/response.js';
import ActivityService from './activityService.js';
import WebhookService from './webhookService.js';

export const DISPUTE_STATUSES = [
  'open',
  'awaiting_response',
  'under_review',
  'resolution_proposed',
  'resolved',
  'unresolved'
];

export class DisputeService {
  /**
   * Open a dispute on a deal or specific obligation
   */
  static async openDispute({
    dealId,
    businessId,
    userId,
    category,
    description,
    obligationId = null,
    evidenceId = null
  }) {
    if (!category || !category.trim()) {
      throw new AppError('Dispute category is required', 400, 'MISSING_CATEGORY');
    }

    if (!description || !description.trim()) {
      throw new AppError('Dispute description is required', 400, 'MISSING_DESCRIPTION');
    }

    const [deals] = await pool.query('SELECT * FROM deals WHERE id = ?', [dealId]);
    if (deals.length === 0) {
      throw new AppError('Deal not found', 404, 'DEAL_NOT_FOUND');
    }

    const deal = deals[0];

    // Cannot raise dispute on terminal cancelled or terminated deals
    if (['cancelled', 'terminated'].includes(deal.status)) {
      throw new AppError(`Cannot raise dispute on '${deal.status}' deal`, 400, 'DEAL_INACTIVE');
    }

    const disputeId = crypto.randomUUID();
    const conn = await getConnection();

    try {
      await conn.beginTransaction();

      // Insert dispute record
      await conn.query(
        `INSERT INTO disputes (
          id, deal_id, obligation_id, raised_by_business_id,
          category, description, status, resolution_terms, resolved_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'open', NULL, NULL, NOW(), NOW())`,
        [
          disputeId,
          dealId,
          obligationId || null,
          businessId,
          category.trim(),
          description.trim()
        ]
      );

      // Transition deal status to 'disputed'
      await conn.query(
        "UPDATE deals SET status = 'disputed', updated_at = NOW() WHERE id = ?",
        [dealId]
      );

      // If tied to an obligation, mark obligation as disputed
      if (obligationId) {
        await conn.query(
          "UPDATE obligations SET status = 'disputed', updated_at = NOW() WHERE id = ? AND deal_id = ?",
          [obligationId, dealId]
        );
      }

      await ActivityService.logEvent(
        dealId,
        userId,
        businessId,
        'dispute.opened',
        {
          dispute_id: disputeId,
          category: category.trim(),
          description: description.trim(),
          obligation_id: obligationId || null,
          evidence_id: evidenceId || null
        },
        conn
      );

      await conn.commit();

      // Trigger asynchronous webhook
      WebhookService.dispatch('dispute.opened', {
        deal_id: dealId,
        dispute_id: disputeId,
        category: category.trim(),
        raised_by_business_id: businessId
      }).catch(() => {});

      return {
        id: disputeId,
        deal_id: dealId,
        obligation_id: obligationId || null,
        raised_by_business_id: businessId,
        category: category.trim(),
        description: description.trim(),
        status: 'open',
        resolution_terms: null,
        resolved_at: null,
        created_at: new Date().toISOString()
      };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * Counterparty responds to dispute with explanation / counter-terms
   */
  static async respondToDispute({
    dealId,
    disputeId,
    businessId,
    userId,
    responseText,
    proposedTerms = null
  }) {
    if (!responseText || !responseText.trim()) {
      throw new AppError('Response explanation text is required', 400, 'MISSING_RESPONSE');
    }

    const [disputes] = await pool.query(
      'SELECT * FROM disputes WHERE id = ? AND deal_id = ?',
      [disputeId, dealId]
    );

    if (disputes.length === 0) {
      throw new AppError('Dispute not found on this deal', 404, 'DISPUTE_NOT_FOUND');
    }

    const dispute = disputes[0];

    if (dispute.status === 'resolved') {
      throw new AppError('Dispute is already resolved', 400, 'DISPUTE_ALREADY_RESOLVED');
    }

    const nextStatus = proposedTerms ? 'resolution_proposed' : 'under_review';
    const conn = await getConnection();

    try {
      await conn.beginTransaction();

      await conn.query(
        `UPDATE disputes 
         SET status = ?,
             resolution_terms = COALESCE(?, resolution_terms),
             updated_at = NOW()
         WHERE id = ?`,
        [nextStatus, proposedTerms ? proposedTerms.trim() : null, disputeId]
      );

      await ActivityService.logEvent(
        dealId,
        userId,
        businessId,
        'dispute.response_submitted',
        {
          dispute_id: disputeId,
          response: responseText.trim(),
          proposed_terms: proposedTerms ? proposedTerms.trim() : null,
          new_status: nextStatus
        },
        conn
      );

      await conn.commit();

      const [updated] = await pool.query('SELECT * FROM disputes WHERE id = ?', [disputeId]);
      return updated[0];
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * Approve resolution terms and resolve dispute.
   * If zero open disputes remain, deal reverts to 'active' or transitions to 'completed' / 'terminated'.
   */
  static async resolveDispute({
    dealId,
    disputeId,
    businessId,
    userId,
    resolutionTerms,
    resolutionAction = 'resume_active'
  }) {
    if (!resolutionTerms || !resolutionTerms.trim()) {
      throw new AppError('Resolution terms are required to finalize dispute', 400, 'MISSING_RESOLUTION_TERMS');
    }

    const [disputes] = await pool.query(
      'SELECT * FROM disputes WHERE id = ? AND deal_id = ?',
      [disputeId, dealId]
    );

    if (disputes.length === 0) {
      throw new AppError('Dispute not found on this deal', 404, 'DISPUTE_NOT_FOUND');
    }

    const conn = await getConnection();
    try {
      await conn.beginTransaction();

      // 1. Mark dispute resolved
      await conn.query(
        `UPDATE disputes 
         SET status = 'resolved',
             resolution_terms = ?,
             resolved_at = NOW(),
             updated_at = NOW()
         WHERE id = ?`,
        [resolutionTerms.trim(), disputeId]
      );

      // 2. Check if any OTHER open disputes exist on this deal
      const [remainingDisputes] = await conn.query(
        `SELECT COUNT(*) AS open_count 
         FROM disputes 
         WHERE deal_id = ? AND id != ? AND status IN ('open', 'awaiting_response', 'under_review', 'resolution_proposed')`,
        [dealId, disputeId]
      );

      let targetDealStatus = 'disputed';

      // 3. If no open disputes remain, apply resolution action
      if (remainingDisputes[0].open_count === 0) {
        if (resolutionAction === 'complete') {
          targetDealStatus = 'completed';
        } else if (resolutionAction === 'terminate') {
          targetDealStatus = 'terminated';
        } else {
          targetDealStatus = 'active'; // Default: resume active deal
        }

        await conn.query(
          'UPDATE deals SET status = ?, updated_at = NOW() WHERE id = ?',
          [targetDealStatus, dealId]
        );
      }

      await ActivityService.logEvent(
        dealId,
        userId,
        businessId,
        'dispute.resolved',
        {
          dispute_id: disputeId,
          resolution_terms: resolutionTerms.trim(),
          resolution_action: resolutionAction,
          deal_status: targetDealStatus
        },
        conn
      );

      await conn.commit();

      // Trigger asynchronous webhook
      WebhookService.dispatch('dispute.resolved', {
        deal_id: dealId,
        dispute_id: disputeId,
        resolution_terms: resolutionTerms.trim(),
        deal_status: targetDealStatus
      }).catch(() => {});

      const [updated] = await pool.query('SELECT * FROM disputes WHERE id = ?', [disputeId]);

      return {
        dispute: updated[0],
        deal_status: targetDealStatus
      };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * List disputes for deal
   */
  static async listDisputes(dealId) {
    const [rows] = await pool.query(
      `SELECT 
        d.id,
        d.deal_id,
        d.obligation_id,
        d.raised_by_business_id,
        d.category,
        d.description,
        d.status,
        d.resolution_terms,
        d.resolved_at,
        d.created_at,
        d.updated_at,
        b.name AS raised_by_business_name,
        o.title AS obligation_title
      FROM disputes d
      LEFT JOIN businesses b ON d.raised_by_business_id = b.id
      LEFT JOIN obligations o ON d.obligation_id = o.id
      WHERE d.deal_id = ?
      ORDER BY d.created_at DESC`,
      [dealId]
    );

    return rows;
  }

  /**
   * Get single dispute details
   */
  static async getDispute(dealId, disputeId) {
    const [rows] = await pool.query(
      `SELECT 
        d.id,
        d.deal_id,
        d.obligation_id,
        d.raised_by_business_id,
        d.category,
        d.description,
        d.status,
        d.resolution_terms,
        d.resolved_at,
        d.created_at,
        d.updated_at,
        b.name AS raised_by_business_name,
        o.title AS obligation_title
      FROM disputes d
      LEFT JOIN businesses b ON d.raised_by_business_id = b.id
      LEFT JOIN obligations o ON d.obligation_id = o.id
      WHERE d.id = ? AND d.deal_id = ?`,
      [disputeId, dealId]
    );

    if (rows.length === 0) {
      throw new AppError('Dispute not found', 404, 'DISPUTE_NOT_FOUND');
    }

    return rows[0];
  }
}

export default DisputeService;
