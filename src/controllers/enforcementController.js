import EnforcementService from '../services/enforcementService.js';
import { sendSuccess } from '../utils/response.js';

export async function initiateCurePeriod(req, res, next) {
  try {
    const { dealId } = req.params;
    const { reason, obligationId } = req.body;
    const businessId = req.business.id;
    const userId = req.user.id;

    const result = await EnforcementService.initiateCurePeriod({
      dealId,
      businessId,
      userId,
      reason,
      obligationId
    });

    return sendSuccess(res, result, 201);
  } catch (err) {
    next(err);
  }
}

export async function resolveCure(req, res, next) {
  try {
    const { dealId } = req.params;
    const { resolutionNotes } = req.body;
    const businessId = req.business.id;
    const userId = req.user.id;

    const result = await EnforcementService.resolveCure({
      dealId,
      businessId,
      userId,
      resolutionNotes
    });

    return sendSuccess(res, result, 200);
  } catch (err) {
    next(err);
  }
}

export async function escalateToBlacklist(req, res, next) {
  try {
    const { dealId } = req.params;
    const businessId = req.business.id;
    const userId = req.user.id;

    const result = await EnforcementService.escalateToBlacklistAndDossier({
      dealId,
      businessId,
      userId
    });

    return sendSuccess(res, result, 201);
  } catch (err) {
    next(err);
  }
}

export async function getRegulatoryDossier(req, res, next) {
  try {
    const { dealId } = req.params;
    const result = await EnforcementService.getRegulatoryDossier(dealId);
    return sendSuccess(res, result, 200);
  } catch (err) {
    next(err);
  }
}
