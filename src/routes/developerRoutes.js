import { Router } from 'express';
import {
  listApiKeys,
  createApiKey,
  revokeApiKey,
  testWebhookPing
} from '../controllers/developerController.js';
import { authenticate, requireBusiness } from '../middleware/auth.js';

const router = Router();

// Developer routes require authentication and an active business
router.use(authenticate, requireBusiness);

// API Keys Management
router.get('/keys', listApiKeys);
router.post('/keys', createApiKey);
router.delete('/keys/:keyId', revokeApiKey);

// Webhook Testing
router.post('/webhooks/:endpointId/test-ping', testWebhookPing);

export default router;
