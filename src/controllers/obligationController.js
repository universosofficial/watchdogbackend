import ObligationService from '../services/obligationService.js';
import { sendSuccess } from '../utils/response.js';

export async function createObligation(req, res, next) {
  try {
    const { dealId } = req.params;
    const { title, description, responsible_business_id, type, due_date } = req.body;

    const result = await ObligationService.createObligation({
      dealId,
      creatorBusinessId: req.businessId,
      userId: req.userId,
      title,
      description,
      responsibleBusinessId: responsible_business_id,
      type,
      dueDate: due_date
    });

    return sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

export async function listObligations(req, res, next) {
  try {
    const { dealId } = req.params;
    const obligations = await ObligationService.listObligations(dealId);
    return sendSuccess(res, { count: obligations.length, obligations });
  } catch (error) {
    next(error);
  }
}

export async function updateObligationStatus(req, res, next) {
  try {
    const { dealId, obligationId } = req.params;
    const { status } = req.body;

    const result = await ObligationService.updateStatus({
      dealId,
      obligationId,
      businessId: req.businessId,
      userId: req.userId,
      status
    });

    return sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

export async function extendObligationDeadline(req, res, next) {
  try {
    const { dealId, obligationId } = req.params;
    const { new_due_date, reason } = req.body;

    const result = await ObligationService.extendDeadline({
      dealId,
      obligationId,
      businessId: req.businessId,
      userId: req.userId,
      newDueDate: new_due_date,
      reason
    });

    return sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}
