/**
 * Message Parser & Command Extractor
 * Parses incoming Meta Cloud API WhatsApp webhooks and extracts standardized intent/payload
 */

/**
 * Standardize Nigerian / International phone number to E.164 digits without '+'
 * e.g., '0803 123 4567' -> '2348031234567'
 *       '+2348031234567' -> '2348031234567'
 */
export function normalizePhoneNumber(rawPhone) {
  if (!rawPhone) return '';
  let cleaned = String(rawPhone).replace(/[^0-9]/g, '');

  // Handle standard Nigerian local 11-digit format starting with '0' (e.g. 08031234567 -> 2348031234567)
  if (cleaned.length === 11 && cleaned.startsWith('0')) {
    cleaned = '234' + cleaned.substring(1);
  }

  return cleaned;
}

/**
 * Parse an incoming Meta Webhook body and extract individual messages
 * @param {object} body - Meta Webhook JSON payload
 * @returns {Array<object>} Extracted messages
 */
export function parseIncomingWebhook(body) {
  const extracted = [];

  if (!body || body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) {
    return extracted;
  }

  for (const entry of body.entry) {
    if (!Array.isArray(entry.changes)) continue;

    for (const change of entry.changes) {
      const value = change.value;
      if (!value || !Array.isArray(value.messages)) continue;

      const contacts = value.contacts || [];
      const senderContact = contacts[0] || {};
      const senderProfileName = senderContact.profile?.name || '';

      for (const msg of value.messages) {
        const from = normalizePhoneNumber(msg.from);
        const msgId = msg.id;
        const timestamp = msg.timestamp;
        const type = msg.type;

        let text = '';
        let payload = null;
        let media = null;

        if (type === 'text' && msg.text) {
          text = (msg.text.body || '').trim();
        } else if (type === 'interactive' && msg.interactive) {
          if (msg.interactive.type === 'button_reply') {
            payload = msg.interactive.button_reply?.id || '';
            text = msg.interactive.button_reply?.title || '';
          } else if (msg.interactive.type === 'list_reply') {
            payload = msg.interactive.list_reply?.id || '';
            text = msg.interactive.list_reply?.title || '';
          }
        } else if (type === 'button' && msg.button) {
          payload = msg.button.payload || '';
          text = msg.button.text || '';
        } else if (type === 'image' && msg.image) {
          media = {
            id: msg.image.id,
            mimeType: msg.image.mime_type || 'image/jpeg',
            caption: (msg.image.caption || '').trim(),
            filename: `image_${Date.now()}.jpg`
          };
          text = media.caption;
        } else if (type === 'document' && msg.document) {
          media = {
            id: msg.document.id,
            mimeType: msg.document.mime_type || 'application/pdf',
            caption: (msg.document.caption || '').trim(),
            filename: msg.document.filename || `doc_${Date.now()}.pdf`
          };
          text = media.caption;
        }

        extracted.push({
          from,
          senderName: senderProfileName,
          messageId: msgId,
          timestamp,
          type,
          text,
          payload,
          media,
          raw: msg
        });
      }
    }
  }

  return extracted;
}

/**
 * Extract intent and command arguments from message text or payload
 */
export function extractCommandIntent(message) {
  const text = (message.text || '').trim();
  const payload = (message.payload || '').trim();

  // 1. Check interactive payloads first
  if (payload) {
    if (payload.startsWith('ACCEPT_DEAL_')) {
      // e.g. ACCEPT_DEAL_{dealId}_{versionId}
      const parts = payload.split('_');
      return {
        intent: 'ACCEPT_DEAL',
        dealId: parts[2],
        versionId: parts[3] || null
      };
    }

    if (payload.startsWith('DECLINE_DEAL_')) {
      return {
        intent: 'DECLINE_DEAL',
        dealId: payload.replace('DECLINE_DEAL_', '')
      };
    }

    if (payload.startsWith('VIEW_TERMS_')) {
      return {
        intent: 'VIEW_TERMS',
        dealId: payload.replace('VIEW_TERMS_', '')
      };
    }

    if (payload.startsWith('ATTACH_EVID_')) {
      // e.g. ATTACH_EVID_{dealId}_{obligationId}
      const rest = payload.replace('ATTACH_EVID_', '');
      const parts = rest.split('_');
      return {
        intent: 'ATTACH_EVIDENCE_CHOICE',
        dealId: parts[0],
        obligationId: parts[1] === 'GENERAL' ? null : parts[1]
      };
    }

    if (payload.startsWith('CONFIRM_PAYMENT_')) {
      const rest = payload.replace('CONFIRM_PAYMENT_', '');
      const [dealId, paymentId] = rest.split('_');
      return {
        intent: 'CONFIRM_PAYMENT',
        dealId,
        paymentId
      };
    }

    if (payload.startsWith('DISPUTE_PAYMENT_')) {
      const rest = payload.replace('DISPUTE_PAYMENT_', '');
      const [dealId, paymentId] = rest.split('_');
      return {
        intent: 'DISPUTE_PAYMENT',
        dealId,
        paymentId
      };
    }
  }

  // 2. Registration pattern: REGISTER: [Full Name], [Business Name], [RC Number]
  const registerMatch = text.match(/^REGISTER:\s*([^,]+),\s*([^,]+)(?:,\s*([^,]+))?$/i);
  if (registerMatch) {
    return {
      intent: 'REGISTER_USER',
      fullName: registerMatch[1].trim(),
      businessName: registerMatch[2].trim(),
      rcNumber: (registerMatch[3] || '').trim() || null
    };
  }

  // 3. Command checks
  const lowerText = text.toLowerCase();

  if (lowerText === '/deal create' || lowerText === 'create deal' || lowerText === '/create deal') {
    return { intent: 'CREATE_DEAL_PROMPT' };
  }

  if (lowerText.startsWith('/deal ') && !lowerText.includes('create')) {
    const dealRef = text.substring(6).trim();
    return { intent: 'GET_DEAL_DETAIL', dealRef };
  }

  if (lowerText === 'status' || lowerText === '/status' || lowerText === 'my deals' || lowerText === '/deals') {
    return { intent: 'STATUS_INQUIRY' };
  }

  if (lowerText === '/help' || lowerText === 'help' || lowerText === 'menu' || lowerText === 'hi' || lowerText === 'hello') {
    return { intent: 'HELP_MENU' };
  }

  // 4. Media upload intent
  if (message.type === 'image' || message.type === 'document' || message.media) {
    return {
      intent: 'MEDIA_UPLOAD',
      media: message.media
    };
  }

  return { intent: 'UNKNOWN', text };
}
