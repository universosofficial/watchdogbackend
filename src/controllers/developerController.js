import ApiKeyService from '../services/apiKeyService.js';
import WebhookService from '../services/webhookService.js';
import { sendSuccess, sendError } from '../utils/response.js';

/**
 * GET /api/v1/developer/keys
 */
export async function listApiKeys(req, res, next) {
  try {
    const keys = await ApiKeyService.listApiKeys(req.businessId);
    return sendSuccess(res, { count: keys.length, keys });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/developer/keys
 */
export async function createApiKey(req, res, next) {
  try {
    const { name, environment = 'live', scopes } = req.body;

    const result = await ApiKeyService.generateApiKey({
      businessId: req.businessId,
      userId: req.userId,
      name,
      environment,
      scopes
    });

    return sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/v1/developer/keys/:keyId
 */
export async function revokeApiKey(req, res, next) {
  try {
    const { keyId } = req.params;
    const result = await ApiKeyService.revokeApiKey(keyId, req.businessId);
    return sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/developer/webhooks/:endpointId/test-ping
 */
export async function testWebhookPing(req, res, next) {
  try {
    const { endpointId } = req.params;
    
    // Dispatch test delivery
    const delivery = await WebhookService.dispatchTestPing(endpointId, req.businessId);
    return sendSuccess(res, delivery);
  } catch (error) {
    next(error);
  }
}
