/**
 * WhatsApp Business Integration Routes
 * Mounted at: /api/v1/integrations/whatsapp
 */
import express from 'express';
import { WhatsappWebhookController } from '../controllers/whatsappWebhookController.js';

const router = express.Router();

// Meta Cloud API Handshake
router.get('/webhook', WhatsappWebhookController.verifyWebhook);

// Meta Cloud API Event Ingestion
router.post('/webhook', WhatsappWebhookController.handleIncomingWebhook);

// Local Development & Mock Testing Endpoints
router.post('/mock-incoming', WhatsappWebhookController.handleMockIncoming);
router.get('/mock-history', WhatsappWebhookController.getMockHistory);
router.post('/mock-clear', WhatsappWebhookController.clearMockHistory);

export default router;
