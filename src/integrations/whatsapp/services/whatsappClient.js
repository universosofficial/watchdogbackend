/**
 * WhatsApp Meta Cloud API Client & Mock Dispatcher
 * Sends interactive messages, quick-reply buttons, text, and downloads media.
 */
import { normalizePhoneNumber } from './messageParser.js';

export class WhatsappClient {
  constructor() {
    this.phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || 'mock_phone_number_id';
    this.apiToken = process.env.WHATSAPP_API_TOKEN || 'mock_api_token';
    this.apiVersion = process.env.WHATSAPP_API_VERSION || 'v19.0';
    this.useMock = process.env.USE_WHATSAPP_MOCK === 'true' || !process.env.WHATSAPP_API_TOKEN;

    // In-memory record of sent messages for local testing and assertions
    this.mockSentMessages = [];
  }

  get isMock() {
    return this.useMock;
  }

  /**
   * Log and record mock outgoing message
   */
  recordMockMessage(payload) {
    const record = {
      id: `wamid.mock_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      timestamp: new Date().toISOString(),
      ...payload
    };
    this.mockSentMessages.push(record);

    console.log(`\n💬 [WhatsApp Bot -> +${payload.to}] (${payload.type.toUpperCase()})`);
    if (payload.text) {
      console.log(payload.text);
    }
    if (payload.buttons && payload.buttons.length > 0) {
      console.log('Buttons:', payload.buttons.map(b => `[${b.title}] (${b.id})`).join(' | '));
    }
    if (payload.sections && payload.sections.length > 0) {
      console.log('List Options:');
      for (const sec of payload.sections) {
        for (const r of sec.rows) {
          console.log(` • [${r.title}] (${r.id}): ${r.description || ''}`);
        }
      }
    }
    console.log('--------------------------------------------------\n');

    return { success: true, messageId: record.id, mock: true };
  }

  /**
   * Get all mock sent messages
   */
  getAllMockMessages() {
    return [...this.mockSentMessages];
  }

  /**
   * Get mock sent messages for a specific recipient
   */
  getMockMessagesFor(to) {
    const normalizedTo = normalizePhoneNumber(to);
    return this.mockSentMessages.filter(m => m.to === normalizedTo);
  }

  /**
   * Get the most recent mock message sent to a recipient
   */
  getLastMockMessage(to) {
    const msgs = this.getMockMessagesFor(to);
    return msgs.length > 0 ? msgs[msgs.length - 1] : null;
  }

  /**
   * Clear mock history
   */
  clearMockHistory() {
    this.mockSentMessages = [];
  }

  /**
   * Send Plain Text Message
   */
  async sendTextMessage(to, text, previewUrl = false) {
    const normalizedTo = normalizePhoneNumber(to);

    if (this.useMock) {
      return this.recordMockMessage({
        to: normalizedTo,
        type: 'text',
        text,
        previewUrl
      });
    }

    const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalizedTo,
      type: 'text',
      text: {
        preview_url: previewUrl,
        body: text
      }
    };

    return this.executeApiRequest(url, payload);
  }

  /**
   * Send Quick Reply Buttons (Meta allows up to 3 interactive buttons)
   */
  async sendQuickReplyButtons(to, bodyText, buttons = []) {
    const normalizedTo = normalizePhoneNumber(to);

    if (this.useMock) {
      return this.recordMockMessage({
        to: normalizedTo,
        type: 'interactive_buttons',
        text: bodyText,
        buttons
      });
    }

    // Meta API limits quick reply buttons to 3 items
    const formattedButtons = buttons.slice(0, 3).map((btn) => ({
      type: 'reply',
      reply: {
        id: String(btn.id).slice(0, 256),
        title: String(btn.title).slice(0, 20)
      }
    }));

    const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalizedTo,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: { buttons: formattedButtons }
      }
    };

    return this.executeApiRequest(url, payload);
  }

  /**
   * Send Interactive List (Menu of options)
   */
  async sendInteractiveList(to, bodyText, buttonText, sections = []) {
    const normalizedTo = normalizePhoneNumber(to);

    if (this.useMock) {
      return this.recordMockMessage({
        to: normalizedTo,
        type: 'interactive_list',
        text: bodyText,
        buttonText,
        sections
      });
    }

    const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalizedTo,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: bodyText },
        action: {
          button: (buttonText || 'Select Option').slice(0, 20),
          sections: sections.map(sec => ({
            title: (sec.title || 'Options').slice(0, 24),
            rows: (sec.rows || []).slice(0, 10).map(r => ({
              id: String(r.id).slice(0, 200),
              title: String(r.title).slice(0, 24),
              description: r.description ? String(r.description).slice(0, 72) : undefined
            }))
          }))
        }
      }
    };

    return this.executeApiRequest(url, payload);
  }

  /**
   * Download media buffer using media ID from Meta Graph API
   */
  async downloadMediaBuffer(mediaId) {
    if (this.useMock || !mediaId || String(mediaId).startsWith('mock_')) {
      // Return valid 1x1 PNG buffer for testing with Cloudinary and image decoders
      const validPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const buf = Buffer.from(validPngBase64, 'base64');
      return {
        buffer: buf,
        mimeType: 'image/png',
        fileSize: buf.length
      };
    }

    // 1. Fetch media URL from Graph API
    const metaUrl = `https://graph.facebook.com/${this.apiVersion}/${mediaId}`;
    const metaRes = await fetch(metaUrl, {
      headers: { Authorization: `Bearer ${this.apiToken}` }
    });

    if (!metaRes.ok) {
      throw new Error(`Failed fetching WhatsApp media URL: ${metaRes.statusText}`);
    }

    const metaData = await metaRes.json();
    const directUrl = metaData.url;

    // 2. Download binary bytes
    const binRes = await fetch(directUrl, {
      headers: { Authorization: `Bearer ${this.apiToken}` }
    });

    if (!binRes.ok) {
      throw new Error(`Failed downloading WhatsApp media bytes: ${binRes.statusText}`);
    }

    const arrayBuffer = await binRes.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      mimeType: metaData.mime_type || 'image/jpeg',
      fileSize: metaData.file_size || arrayBuffer.byteLength
    };
  }

  /**
   * Internal HTTP Executor
   */
  async executeApiRequest(url, payload) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiToken}`
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();
      if (!response.ok) {
        console.error('[WhatsApp Client Error]', data);
        throw new Error(data?.error?.message || 'Meta Cloud API call failed');
      }

      return data;
    } catch (err) {
      console.error('[WhatsApp Network/API Exception]', err.message);
      throw err;
    }
  }
}

export const whatsappClient = new WhatsappClient();
export default whatsappClient;
