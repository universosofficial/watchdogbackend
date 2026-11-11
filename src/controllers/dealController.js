import DealService from '../services/dealService.js';
import ActivityService from '../services/activityService.js';
import { sendSuccess, sendError } from '../utils/response.js';

/**
 * POST /api/v1/deals
 * Create draft deal and initial terms version
 */
export async function createDeal(req, res, next) {
  try {
    const {
      title,
      description,
      amount,
      currency,
      terms_text,
      counterparty_business_id,
      invited_email,
      counterparty_phone,
      invited_phone,
      expected_delivery_date,
      creator_role
    } = req.body;

    const result = await DealService.createDeal({
      creatorBusinessId: req.businessId,
      userId: req.userId,
      title,
      description,
      amount,
      currency,
      termsText: terms_text,
      counterpartyBusinessId: counterparty_business_id,
      invitedEmail: invited_email,
      counterpartyPhone: counterparty_phone,
      invitedPhone: invited_phone,
      expectedDeliveryDate: expected_delivery_date,
      creatorRole: creator_role
    });

    return sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/deals
 * List all deals where user's business is creator or counterparty
 */
export async function listDeals(req, res, next) {
  try {
    const { page, limit, status } = req.query;

    const result = await DealService.listDeals({
      businessId: req.businessId,
      page,
      limit,
      status
    });

    return sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/deals/public/:dealId
 * Unauthenticated public deal preview for shared WhatsApp / SMS links
 */
export async function getPublicDealPreview(req, res, next) {
  try {
    const { dealId } = req.params;
    const result = await DealService.getPublicDealPreview(dealId);
    return sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/deals/:dealId
 * Complete deal details, current version, acceptances status, and participants
 */
export async function getDealById(req, res, next) {
  try {
    const { dealId } = req.params;
    const result = await DealService.getDealDetails(dealId, req.businessId);
    return sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/v1/deals/:dealId/terms
 * Update terms (creates a new version; resets acceptances; transitions to awaiting_acceptance)
 */
export async function updateTerms(req, res, next) {
  try {
    const { dealId } = req.params;
    const { terms_text } = req.body;

    const result = await DealService.updateTerms({
      dealId,
      businessId: req.businessId,
      userId: req.userId,
      termsText: terms_text
    });

    return sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/deals/:dealId/accept
 * Record acceptance of current version by authenticated business
 */
export async function acceptDeal(req, res, next) {
  try {
    const { dealId } = req.params;
    const ipAddress = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (req.body?.simulate_partner) {
      if (process.env.NODE_ENV === 'production') {
        return sendError(res, 'Partner simulation is disabled in production environments', 'FORBIDDEN_SIMULATION', 403);
      }
      const result = await DealService.simulatePartnerAccept({
        dealId,
        businessId: req.businessId,
        userId: req.userId
      });
      return sendSuccess(res, result);
    }

    const result = await DealService.acceptDeal({
      dealId,
      businessId: req.businessId,
      userId: req.userId,
      ipAddress
    });

    return sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/deals/:dealId/simulate-accept
 * Instant simulate counterparty accepting invite and activating escrow
 */
export async function simulatePartnerAccept(req, res, next) {
  try {
    if (process.env.NODE_ENV === 'production') {
      return sendError(res, 'Partner simulation is disabled in production environments', 'FORBIDDEN_SIMULATION', 403);
    }
    const { dealId } = req.params;
    const result = await DealService.simulatePartnerAccept({
      dealId,
      businessId: req.businessId,
      userId: req.userId
    });
    return sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/deals/:dealId/audit-chain/verify
 * Cryptographically verifies that no historical audit log for this deal has been tampered with
 */
export async function verifyAuditChain(req, res, next) {
  try {
    const { dealId } = req.params;
    const { ActivityService } = await import('../services/activityService.js');
    const result = await ActivityService.verifyAuditChain(dealId);
    return sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/deals/:dealId/invite
 * Send or regenerate invitation token for counterparty
 */
export async function sendInvitation(req, res, next) {
  try {
    const { dealId } = req.params;
    const { invited_email } = req.body;

    const result = await DealService.sendOrRegenerateInvitation({
      dealId,
      businessId: req.businessId,
      userId: req.userId,
      invitedEmail: invited_email
    });

    return sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/deals/invitations/:token/accept
 * Counterparty accepts invitation to join the deal
 */
export async function acceptInvitation(req, res, next) {
  try {
    const { token } = req.params;

    const result = await DealService.acceptInvitation({
      token,
      businessId: req.businessId,
      userId: req.userId
    });

    return sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/deals/:dealId/activity
 * Chronological audit timeline (read-only)
 */
export async function getDealActivity(req, res, next) {
  try {
    const { dealId } = req.params;
    const timeline = await ActivityService.getDealTimeline(dealId);
    return sendSuccess(res, {
      count: timeline.length,
      timeline
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/deals/:dealId/complete
 * Complete deal (Enforces open disputes guard)
 */
export async function completeDeal(req, res, next) {
  try {
    const { dealId } = req.params;
    const { reason } = req.body;

    const result = await DealService.transitionStatus({
      dealId,
      businessId: req.businessId,
      userId: req.userId,
      targetStatus: 'completed',
      reason: reason || 'Milestone deliverables and settlements verified complete'
    });

    return sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/deals/:dealId/transition
 * General state transition with explicit guards
 */
export async function transitionDealStatus(req, res, next) {
  try {
    const { dealId } = req.params;
    const { target_status, reason } = req.body;

    const result = await DealService.transitionStatus({
      dealId,
      businessId: req.businessId,
      userId: req.userId,
      targetStatus: target_status,
      reason
    });

    return sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/deals/dashboard/summary
 * Fetch metric cards and recent activities for authenticated business
 */
export async function getDashboardSummary(req, res, next) {
  try {
    const summary = await DealService.getDashboardSummary(req.businessId);
    return sendSuccess(res, summary);
  } catch (error) {
    next(error);
  }
}
