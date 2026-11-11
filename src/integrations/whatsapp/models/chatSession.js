/**
 * In-memory Chat Session Tracker with TTL
 * Supports multi-step conversational flows (e.g. deal creation, evidence attachment)
 */
export class ChatSessionManager {
  constructor(defaultTtlMs = 15 * 60 * 1000) {
    this.sessions = new Map();
    this.defaultTtlMs = defaultTtlMs;
  }

  /**
   * Normalize phone number to standard digit key
   */
  normalizeKey(phone) {
    if (!phone) return '';
    return String(phone).replace(/[^0-9]/g, '');
  }

  /**
   * Get active session for a phone number
   */
  getSession(phone) {
    const key = this.normalizeKey(phone);
    const session = this.sessions.get(key);
    if (!session) {
      return { state: 'IDLE', data: {}, updatedAt: Date.now() };
    }

    // Check TTL expiration
    if (Date.now() - session.updatedAt > this.defaultTtlMs) {
      this.sessions.delete(key);
      return { state: 'IDLE', data: {}, updatedAt: Date.now() };
    }

    return session;
  }

  /**
   * Set or update conversational state
   */
  setSession(phone, state, data = {}) {
    const key = this.normalizeKey(phone);
    const existing = this.sessions.get(key) || { data: {} };
    const session = {
      state,
      data: { ...existing.data, ...data },
      updatedAt: Date.now()
    };
    this.sessions.set(key, session);
    return session;
  }

  /**
   * Update session data without changing state
   */
  updateSessionData(phone, data) {
    const key = this.normalizeKey(phone);
    const session = this.getSession(phone);
    session.data = { ...session.data, ...data };
    session.updatedAt = Date.now();
    this.sessions.set(key, session);
    return session;
  }

  /**
   * Reset session back to IDLE
   */
  clearSession(phone) {
    const key = this.normalizeKey(phone);
    this.sessions.delete(key);
  }

  /**
   * Check if user is in a specific state
   */
  isInState(phone, state) {
    const session = this.getSession(phone);
    return session.state === state;
  }
}

export const chatSession = new ChatSessionManager();
export default chatSession;
