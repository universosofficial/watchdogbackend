import WwsEscalationService from '../services/wwsEscalationService.js';
import pool from '../config/db.js';
import { sendSuccess } from '../utils/response.js';

/**
 * Escalate a dispute to World Wide Security
 * POST /api/v1/enforcement/deals/:dealId/disputes/:disputeId/escalate-wws
 * Or POST /api/v1/enforcement/deals/:dealId/escalate-wws
 */
export async function escalateDisputeToWws(req, res, next) {
  try {
    const { dealId, disputeId } = req.params;
    const {
      escalationReason,
      incidentCategory,
      approvedFields,
      authorityConfirmed
    } = req.body;

    const result = await WwsEscalationService.initiateEscalation({
      dealId,
      disputeId,
      businessId: req.businessId,
      userId: req.userId,
      userRole: req.role,
      userEmail: req.user?.email,
      userName: req.user?.full_name,
      escalationReason,
      incidentCategory,
      approvedFields,
      authorityConfirmed: Boolean(authorityConfirmed)
    });

    return sendSuccess(res, result, 200, 'Dispute escalated to World Wide Security');
  } catch (error) {
    next(error);
  }
}

/**
 * Callback receiver for WWS Status Updates
 * POST /api/v1/integration/wws-status-update
 */
export async function receiveWwsStatusCallback(req, res, next) {
  try {
    const result = await WwsEscalationService.handleStatusCallback({
      headers: req.headers,
      body: req.body
    });

    return sendSuccess(res, result, 200, 'Status update acknowledged');
  } catch (error) {
    next(error);
  }
}

/**
 * Get WWS Escalation details for a deal
 * GET /api/v1/enforcement/deals/:dealId/wws-status
 */
export async function getWwsEscalationStatus(req, res, next) {
  try {
    const { dealId } = req.params;
    const [dealRows] = await pool.query(
      'SELECT id, reference_no, wws_case_reference, wws_escalated_at, wws_receipt_json FROM deals WHERE id = ?',
      [dealId]
    );

    if (dealRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Deal not found' });
    }

    const deal = dealRows[0];
    let receipt = null;
    if (deal.wws_receipt_json) {
      receipt = typeof deal.wws_receipt_json === 'string' ? JSON.parse(deal.wws_receipt_json) : deal.wws_receipt_json;
    }

    return sendSuccess(res, {
      deal_id: deal.id,
      deal_reference: deal.reference_no,
      wws_case_reference: deal.wws_case_reference,
      wws_escalated_at: deal.wws_escalated_at,
      receipt
    });
  } catch (error) {
    next(error);
  }
}
