/**
 * Telegram Bot API Client & Mock Dispatcher
 * Sends messages, inline keyboards, and downloads media.
 */
export class TelegramClient {
  constructor() {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN || 'mock_telegram_token';
    this.botUsername = process.env.TELEGRAM_BOT_USERNAME || 'DigitalWatchdogBot';
    this.useMock = process.env.USE_TELEGRAM_MOCK === 'true' || !process.env.TELEGRAM_BOT_TOKEN;
    this.mockSentMessages = [];
  }

  get isMock() {
    return this.useMock;
  }

  recordMockMessage(payload) {
    const record = {
      messageId: `tg_msg_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      timestamp: new Date().toISOString(),
      ...payload
    };
    this.mockSentMessages.push(record);

    console.log(`\n✈️ [Telegram Bot -> Chat ID: ${payload.chatId}]`);
    if (payload.text) {
      console.log(payload.text);
    }
    if (payload.reply_markup && payload.reply_markup.inline_keyboard) {
      const btnRows = payload.reply_markup.inline_keyboard.map(row => 
        row.map(b => `[${b.text}] (${b.callback_data || b.url || ''})`).join(' | ')
      );
      console.log('Inline Buttons:\n ' + btnRows.join('\n '));
    }
    console.log('--------------------------------------------------\n');

    return { success: true, messageId: record.messageId, mock: true };
  }

  getAllMockMessages() {
    return [...this.mockSentMessages];
  }

  getMockMessagesFor(chatId) {
    return this.mockSentMessages.filter(m => String(m.chatId) === String(chatId));
  }

  getLastMockMessage(chatId) {
    const msgs = this.getMockMessagesFor(chatId);
    return msgs.length > 0 ? msgs[msgs.length - 1] : null;
  }

  clearMockHistory() {
    this.mockSentMessages = [];
  }

  /**
   * Send text message with optional inline keyboard buttons
   * @param {string|number} chatId
   * @param {string} text
   * @param {object} [options={}] - { parse_mode, reply_markup }
   */
  async sendMessage(chatId, text, options = {}) {
    const payload = {
      chatId: String(chatId),
      text,
      parse_mode: options.parse_mode || 'Markdown',
      reply_markup: options.reply_markup || undefined
    };

    if (this.useMock) {
      return this.recordMockMessage(payload);
    }

    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const body = {
      chat_id: chatId,
      text,
      parse_mode: options.parse_mode || 'Markdown',
      reply_markup: options.reply_markup
    };

    return this.executeApiRequest(url, body);
  }

  /**
   * Helper to send message with interactive inline buttons
   */
  async sendInlineButtons(chatId, text, buttons = []) {
    // buttons is an array of objects: [{ text, callback_data, url }]
    const inline_keyboard = buttons.map(b => [b]);
    return this.sendMessage(chatId, text, {
      reply_markup: { inline_keyboard }
    });
  }

  /**
   * Download file buffer from Telegram
   */
  async downloadFileBuffer(fileId) {
    if (this.useMock || !fileId || String(fileId).startsWith('mock_')) {
      const validPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const buf = Buffer.from(validPngBase64, 'base64');
      return {
        buffer: buf,
        mimeType: 'image/png',
        fileSize: buf.length
      };
    }

    const getFileUrl = `https://api.telegram.org/bot${this.botToken}/getFile?file_id=${fileId}`;
    const res = await fetch(getFileUrl);
    const data = await res.json();
    if (!data.ok || !data.result?.file_path) {
      throw new Error('Failed to resolve Telegram file path');
    }

    const downloadUrl = `https://api.telegram.org/file/bot${this.botToken}/${data.result.file_path}`;
    const fileRes = await fetch(downloadUrl);
    const arrayBuffer = await fileRes.arrayBuffer();

    return {
      buffer: Buffer.from(arrayBuffer),
      mimeType: 'image/jpeg',
      fileSize: arrayBuffer.byteLength
    };
  }

  async executeApiRequest(url, payload) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!data.ok) {
        console.error('[Telegram API Error]', data);
        throw new Error(data.description || 'Telegram API request failed');
      }
      return data;
    } catch (err) {
      console.error('[Telegram Network/API Exception]', err.message);
      throw err;
    }
  }
}

export const telegramClient = new TelegramClient();
export default telegramClient;
