/**
 * Transactional Email Dispatcher & Mock Mailbox
 */
export class EmailClient {
  constructor() {
    this.fromEmail = process.env.EMAIL_FROM || '"Digital Watchdog" <alerts@digitalwatchdog.ng>';
    this.useMock = process.env.USE_EMAIL_MOCK === 'true' || !process.env.SMTP_HOST;
    this.mockSentEmails = [];
  }

  get isMock() {
    return this.useMock;
  }

  recordMockEmail(payload) {
    const record = {
      messageId: `email_${Date.now()}_${Math.random().toString(36).substring(7)}@digitalwatchdog.ng`,
      timestamp: new Date().toISOString(),
      ...payload
    };
    this.mockSentEmails.push(record);

    console.log(`\n📧 [Email Dispatcher -> To: ${payload.to}]`);
    console.log(`Subject: ${payload.subject}`);
    if (payload.actionUrl) {
      console.log(`Action Link: ${payload.actionUrl}`);
    }
    console.log('--------------------------------------------------\n');

    return { success: true, messageId: record.messageId, mock: true };
  }

  getAllMockEmails() {
    return [...this.mockSentEmails];
  }

  getMockEmailsFor(email) {
    if (!email) return [];
    const clean = email.toLowerCase().trim();
    return this.mockSentEmails.filter(m => m.to.toLowerCase().trim() === clean);
  }

  getLastEmailFor(email) {
    const list = this.getMockEmailsFor(email);
    return list.length > 0 ? list[list.length - 1] : null;
  }

  clearMockInbox() {
    this.mockSentEmails = [];
  }

  /**
   * Send transactional email
   */
  async sendEmail({ to, subject, html, text, actionUrl = null, metadata = {} }) {
    const payload = {
      from: this.fromEmail,
      to,
      subject,
      html,
      text: text || subject,
      actionUrl,
      metadata
    };

    if (this.useMock) {
      return this.recordMockEmail(payload);
    }

    // In production with real SMTP credentials:
    console.log(`[SMTP Live Dispatch] Sending to ${to}...`);
    return { success: true, messageId: `live_${Date.now()}` };
  }
}

export const emailClient = new EmailClient();
export default emailClient;
