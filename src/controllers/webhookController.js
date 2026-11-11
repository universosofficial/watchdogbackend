import WebhookService from '../services/webhookService.js';
import { sendSuccess } from '../utils/response.js';

export async function registerWebhook(req, res, next) {
  try {
    const { url, events } = req.body;

    const result = await WebhookService.registerEndpoint({
      businessId: req.businessId,
      url,
      events
    });

    return sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

export async function listWebhooks(req, res, next) {
  try {
    const endpoints = await WebhookService.listEndpoints(req.businessId);
    return sendSuccess(res, { count: endpoints.length, endpoints });
  } catch (error) {
    next(error);
  }
}

export async function listWebhookDeliveries(req, res, next) {
  try {
    const { endpointId } = req.params;
    const deliveries = await WebhookService.listDeliveries(endpointId, req.businessId);
    return sendSuccess(res, { count: deliveries.length, deliveries });
  } catch (error) {
    next(error);
  }
}

export async function deleteWebhook(req, res, next) {
  try {
    const { endpointId } = req.params;
    const result = await WebhookService.deleteEndpoint(endpointId, req.businessId);
    return sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}
