import { Router } from 'express';
import {
  registerWebhook,
  listWebhooks,
  listWebhookDeliveries,
  deleteWebhook
} from '../controllers/webhookController.js';
import { authenticate, requireBusiness } from '../middleware/auth.js';

const router = Router();

router.use(authenticate, requireBusiness);

router.post('/', registerWebhook);
router.get('/', listWebhooks);
router.get('/:endpointId/deliveries', listWebhookDeliveries);
router.delete('/:endpointId', deleteWebhook);

export default router;
