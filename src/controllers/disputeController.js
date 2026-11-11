import DisputeService from '../services/disputeService.js';
import { sendSuccess } from '../utils/response.js';

export async function openDispute(req, res, next) {
  try {
    const { dealId } = req.params;
    const { category, description, obligation_id, evidence_id } = req.body;

    const result = await DisputeService.openDispute({
      dealId,
      businessId: req.businessId,
      userId: req.userId,
      category,
      description,
      obligationId: obligation_id,
      evidenceId: evidence_id
    });

    return sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

export async function respondToDispute(req, res, next) {
  try {
    const { dealId, disputeId } = req.params;
    const { response_text, proposed_terms } = req.body;

    const result = await DisputeService.respondToDispute({
      dealId,
      disputeId,
      businessId: req.businessId,
      userId: req.userId,
      responseText: response_text,
      proposedTerms: proposed_terms
    });

    return sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

export async function resolveDispute(req, res, next) {
  try {
    const { dealId, disputeId } = req.params;
    const { resolution_terms, resolution_action } = req.body;

    const result = await DisputeService.resolveDispute({
      dealId,
      disputeId,
      businessId: req.businessId,
      userId: req.userId,
      resolutionTerms: resolution_terms,
      resolutionAction: resolution_action
    });

    return sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

export async function listDisputes(req, res, next) {
  try {
    const { dealId } = req.params;
    const disputes = await DisputeService.listDisputes(dealId);
    return sendSuccess(res, { count: disputes.length, disputes });
  } catch (error) {
    next(error);
  }
}

export async function getDispute(req, res, next) {
  try {
    const { dealId, disputeId } = req.params;
    const dispute = await DisputeService.getDispute(dealId, disputeId);
    return sendSuccess(res, dispute);
  } catch (error) {
    next(error);
  }
}
