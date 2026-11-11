/**
 * Telegram Webhook & Mock Controller
 */
import { TelegramEngine } from '../services/telegramEngine.js';
import telegramClient from '../services/telegramClient.js';
import { sendSuccess, sendError } from '../../../utils/response.js';

export class TelegramWebhookController {
  /**
   * POST /api/v1/integrations/telegram/webhook
   */
  static async handleWebhook(req, res) {
    res.status(200).json({ ok: true });
    try {
      if (req.body && (req.body.message || req.body.callback_query)) {
        await TelegramEngine.processUpdate(req.body);
      }
    } catch (err) {
      console.error('[Telegram Webhook Error]', err);
    }
  }

  /**
   * POST /api/v1/integrations/telegram/mock-incoming
   * Simulates incoming Telegram messages or button callbacks for local testing
   */
  static async handleMockIncoming(req, res) {
    try {
      const { chatId = '11112222', text, callback_data, photo, document, from = {} } = req.body;

      let update;
      if (callback_data) {
        update = {
          callback_query: {
            id: `cb_${Date.now()}`,
            from: { id: chatId, first_name: from.first_name || 'Test User', ...from },
            message: { chat: { id: chatId }, message_id: 101 },
            data: callback_data
          }
        };
      } else {
        update = {
          message: {
            message_id: 101,
            from: { id: chatId, first_name: from.first_name || 'Test User', ...from },
            chat: { id: chatId },
            date: Math.floor(Date.now() / 1000),
            text: text || '',
            photo: photo ? [{ file_id: photo.file_id || 'mock_file_123' }] : undefined,
            document: document ? { file_id: document.file_id || 'mock_doc_123', file_name: document.file_name } : undefined,
            caption: req.body.caption
          }
        };
      }

      const beforeCount = telegramClient.getAllMockMessages().length;
      await TelegramEngine.processUpdate(update);
      const allMock = telegramClient.getAllMockMessages();
      const newReplies = allMock.slice(beforeCount);

      return sendSuccess(res, {
        processed: true,
        chatId: String(chatId),
        input: { text, callback_data },
        replies: newReplies
      });
    } catch (err) {
      console.error('[Mock Telegram Error]', err);
      return sendError(res, err.message, 'MOCK_PROCESS_ERROR', 500);
    }
  }

  /**
   * GET /api/v1/integrations/telegram/mock-history
   */
  static getMockHistory(req, res) {
    const { chatId } = req.query;
    const history = chatId ? telegramClient.getMockMessagesFor(chatId) : telegramClient.getAllMockMessages();
    return sendSuccess(res, { count: history.length, messages: history });
  }

  /**
   * POST /api/v1/integrations/telegram/mock-clear
   */
  static clearMockHistory(req, res) {
    telegramClient.clearMockHistory();
    return sendSuccess(res, { cleared: true });
  }
}

export default TelegramWebhookController;
