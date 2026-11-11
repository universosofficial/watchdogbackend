/**
 * Telegram In-Memory Session & Chat-to-Identity Linker
 */
export class TelegramSessionManager {
  constructor(defaultTtlMs = 15 * 60 * 1000) {
    this.sessions = new Map();
    this.identityLinks = new Map(); // chatId -> { userId, businessId, email, phone }
    this.defaultTtlMs = defaultTtlMs;

    // Seed default links for our test accounts so testing works instantly
    this.identityLinks.set('11112222', {
      email: 'owner@alphasupplies.ng',
      phone: '+2348011112222'
    });
    this.identityLinks.set('33334444', {
      email: 'procurement@betabuilders.ng',
      phone: '+2348033334444'
    });
  }

  getSession(chatId) {
    const key = String(chatId);
    const session = this.sessions.get(key);
    if (!session) {
      return { state: 'IDLE', data: {}, updatedAt: Date.now() };
    }
    if (Date.now() - session.updatedAt > this.defaultTtlMs) {
      this.sessions.delete(key);
      return { state: 'IDLE', data: {}, updatedAt: Date.now() };
    }
    return session;
  }

  setSession(chatId, state, data = {}) {
    const key = String(chatId);
    const existing = this.sessions.get(key) || { data: {} };
    const session = {
      state,
      data: { ...existing.data, ...data },
      updatedAt: Date.now()
    };
    this.sessions.set(key, session);
    return session;
  }

  clearSession(chatId) {
    this.sessions.delete(String(chatId));
  }

  linkChatToIdentity(chatId, identity) {
    this.identityLinks.set(String(chatId), identity);
  }

  getLinkedIdentity(chatId) {
    return this.identityLinks.get(String(chatId)) || null;
  }

  findChatIdByPhoneOrEmail(phone, email) {
    for (const [chatId, ident] of this.identityLinks.entries()) {
      if (email && ident.email && ident.email.toLowerCase() === email.toLowerCase()) {
        return chatId;
      }
      if (phone && ident.phone && ident.phone.replace(/[^0-9]/g, '') === phone.replace(/[^0-9]/g, '')) {
        return chatId;
      }
    }
    return null;
  }
}

export const telegramSession = new TelegramSessionManager();
export default telegramSession;
