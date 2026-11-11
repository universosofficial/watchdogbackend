/**
 * Telegram Bot Integration Routes
 * Mounted at: /api/v1/integrations/telegram
 */
import express from 'express';
import { TelegramWebhookController } from '../controllers/telegramWebhookController.js';

const router = express.Router();

// Production Webhook
router.post('/webhook', TelegramWebhookController.handleWebhook);

// Development & Mock Testing Endpoints
router.post('/mock-incoming', TelegramWebhookController.handleMockIncoming);
router.get('/mock-history', TelegramWebhookController.getMockHistory);
router.post('/mock-clear', TelegramWebhookController.clearMockHistory);

export default router;
