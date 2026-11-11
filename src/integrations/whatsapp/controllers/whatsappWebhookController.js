/**
 * WhatsApp Meta Webhook Controller
 * Handles Meta Cloud API handshake, webhook ingestion, and local development mock testing
 */
import { parseIncomingWebhook } from '../services/messageParser.js';
import { ConversationEngine } from '../services/conversationEngine.js';
import whatsappClient from '../services/whatsappClient.js';
import { sendSuccess, sendError } from '../../../utils/response.js';

export class WhatsappWebhookController {
  /**
   * GET /api/v1/integrations/whatsapp/webhook
   * Meta Cloud API Webhook Verification Handshake
   */
  static verifyWebhook(req, res) {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN || 'digital_watchdog_meta_verify_token_2026';

    if (mode === 'subscribe' && token === expectedToken) {
      console.log('✅ [WhatsApp Webhook] Verification handshake successful');
      return res.status(200).send(challenge);
    }

    console.warn('❌ [WhatsApp Webhook] Handshake verification failed: Token mismatch or invalid mode');
    return res.sendStatus(403);
  }

  /**
   * POST /api/v1/integrations/whatsapp/webhook
   * Ingests Meta notifications (messages, buttons, media)
   * Responds HTTP 200 immediately, then processes asynchronously
   */
  static async handleIncomingWebhook(req, res) {
    // 1. Immediately return HTTP 200 to prevent Meta retry storm
    res.status(200).json({ status: 'ok' });

    try {
      const messages = parseIncomingWebhook(req.body);
      if (!messages || messages.length === 0) {
        return;
      }

      for (const msg of messages) {
        try {
          await ConversationEngine.processMessage(msg);
        } catch (msgErr) {
          console.error('[WhatsApp Message Processing Error]', msgErr);
        }
      }
    } catch (err) {
      console.error('[WhatsApp Ingestion Error]', err);
    }
  }

  /**
   * POST /api/v1/integrations/whatsapp/mock-incoming
   * Local Developer / Automated Testing Endpoint
   * Allows simulating incoming WhatsApp payloads directly and returning bot responses
   */
  static async handleMockIncoming(req, res) {
    try {
      const { from, text, payload, type = 'text', media, senderName } = req.body;

      if (!from) {
        return sendError(res, 'Field "from" (sender phone number) is required', 'MISSING_FROM', 400);
      }

      const standardizedMsg = {
        from: String(from).replace(/[^0-9]/g, ''),
        senderName: senderName || 'Test User',
        messageId: `wamid.mock_in_${Date.now()}`,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type,
        text: text || '',
        payload: payload || null,
        media: media || (type === 'image' ? { id: 'mock_img_123', mimeType: 'image/jpeg', filename: 'test.jpg' } : null),
        raw: req.body
      };

      // Clear previous replies for this phone number to isolate this step's output
      const beforeCount = whatsappClient.getAllMockMessages().length;

      const result = await ConversationEngine.processMessage(standardizedMsg);

      // Collect replies dispatched during this message execution
      const allMock = whatsappClient.getAllMockMessages();
      const newReplies = allMock.slice(beforeCount);

      return sendSuccess(res, {
        processed: true,
        from: standardizedMsg.from,
        input: { text, payload, type },
        result,
        replies: newReplies
      });
    } catch (err) {
      console.error('[Mock Incoming Error]', err);
      return sendError(res, err.message, 'MOCK_PROCESS_ERROR', 500);
    }
  }

  /**
   * GET /api/v1/integrations/whatsapp/mock-history
   */
  static getMockHistory(req, res) {
    const { to } = req.query;
    const history = to ? whatsappClient.getMockMessagesFor(to) : whatsappClient.getAllMockMessages();
    return sendSuccess(res, { count: history.length, messages: history });
  }

  /**
   * POST /api/v1/integrations/whatsapp/mock-clear
   */
  static clearMockHistory(req, res) {
    whatsappClient.clearMockHistory();
    return sendSuccess(res, { cleared: true });
  }
}

export default WhatsappWebhookController;
