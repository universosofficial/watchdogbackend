import DeliveryService from '../services/deliveryService.js';
import { sendSuccess } from '../utils/response.js';

export async function recordDelivery(req, res, next) {
  try {
    const { dealId } = req.params;
    const { items_json, items, dispatch_date, delivery_reference, evidence_id, evidenceId, obligation_id, notes } = req.body;

    const result = await DeliveryService.recordDelivery({
      dealId,
      businessId: req.businessId,
      userId: req.userId,
      items: items_json || items || [],
      dispatchDate: dispatch_date,
      deliveryReference: delivery_reference,
      obligationId: obligation_id,
      evidenceId: evidence_id || evidenceId || null,
      notes
    });

    return sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

export async function updateDeliveryStatus(req, res, next) {
  try {
    const { dealId, deliveryId } = req.params;
    const { status, notes, discrepancy_notes } = req.body;

    const result = await DeliveryService.updateDeliveryStatus({
      dealId,
      deliveryId,
      businessId: req.businessId,
      userId: req.userId,
      status,
      notes: discrepancy_notes || notes
    });

    return sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

export async function listDeliveries(req, res, next) {
  try {
    const { dealId } = req.params;
    const deliveries = await DeliveryService.listDeliveries(dealId);
    return sendSuccess(res, { count: deliveries.length, deliveries });
  } catch (error) {
    next(error);
  }
}
