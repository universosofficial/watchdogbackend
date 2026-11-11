/**
 * Transactional Email & Action Routes
 * Mounted at: /api/v1/integrations/email
 */
import express from 'express';
import { EmailController } from '../controllers/emailController.js';

const router = express.Router();

// 1-Click Browser Actions (from email CTA buttons)
router.get('/actions/accept', EmailController.handleAcceptDeal);
router.get('/actions/confirm-payment', EmailController.handleConfirmPayment);

// Inbound Webhook
router.post('/webhook', EmailController.handleInboundWebhook);

// Mock Mailbox & Testing Endpoints
router.get('/mock-inbox', EmailController.getMockInbox);
router.post('/mock-clear', EmailController.clearMockInbox);
router.post('/mock-send', EmailController.simulateSend);

export default router;
