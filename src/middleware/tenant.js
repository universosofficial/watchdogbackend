import pool from '../config/db.js';
import { sendError } from '../utils/response.js';

/**
 * Tenant Isolation Middleware: requireDealAccess
 * 
 * Verifies that the authenticated business context is a legitimate party
 * (creator_business_id OR counterparty_business_id) to the target deal.
 * 
 * Target route format: /deals/:dealId
 */
export async function requireDealAccess(req, res, next) {
  try {
    const { dealId } = req.params;

    if (!dealId) {
      return sendError(res, 'Target deal ID parameter is required', 'MISSING_DEAL_ID', 400);
    }

    if (!req.businessId) {
      return sendError(
        res,
        'Access denied: You must operate within an active business context to access deals',
        'NO_BUSINESS_CONTEXT',
        403
      );
    }

    // Query deal details
    const [deals] = await pool.query(
      `SELECT 
        d.id,
        d.reference_no,
        d.creator_business_id,
        d.counterparty_business_id,
        d.title,
        d.description,
        d.amount,
        d.currency,
        d.status,
        d.current_version,
        d.created_at,
        d.updated_at
      FROM deals d
      WHERE d.id = ?`,
      [dealId]
    );

    if (deals.length === 0) {
      return sendError(res, `Deal with ID '${dealId}' not found`, 'DEAL_NOT_FOUND', 404);
    }

    const deal = deals[0];

    // Tenant Isolation Check
    const isCreator = req.businessId === deal.creator_business_id;
    const isCounterparty = req.businessId === deal.counterparty_business_id;

    if (!isCreator && !isCounterparty) {
      return sendError(
        res,
        'Access denied: Your business is not an authorized party to this deal',
        'FORBIDDEN',
        403
      );
    }

    // Attach verified deal and party role to request
    req.deal = deal;
    req.dealParty = isCreator ? 'creator' : 'counterparty';

    next();
  } catch (error) {
    console.error('[Tenant Isolation Middleware Error]:', error);
    return sendError(res, 'Internal error verifying deal tenant isolation', 'INTERNAL_ERROR', 500);
  }
}
