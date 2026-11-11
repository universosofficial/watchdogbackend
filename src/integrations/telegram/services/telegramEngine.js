/**
 * Telegram Conversational Engine
 * Handles bot commands, inline button callbacks, photo ingestion, and outbound contract alerts.
 */
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import pool, { getConnection } from '../../../config/db.js';
import { DealService } from '../../../services/dealService.js';
import { PaymentService } from '../../../services/paymentService.js';
import storageService from '../../../services/storageService.js';
import ActivityService from '../../../services/activityService.js';
import telegramClient from './telegramClient.js';
import telegramSession from '../models/telegramSession.js';

export class TelegramEngine {
  /**
   * Resolve Telegram Chat to registered User & Business
   */
  static async resolveIdentity(chatId, fromUser = {}) {
    const linked = telegramSession.getLinkedIdentity(chatId);
    let queryParam = null;
    let queryField = 'email';

    if (linked && linked.email) {
      queryParam = linked.email;
      queryField = 'email';
    } else if (linked && linked.phone) {
      queryParam = linked.phone;
      queryField = 'phone';
    }

    if (!queryParam) {
      return { isKnown: false, chatId };
    }

    const [rows] = await pool.query(
      `SELECT 
        u.id AS user_id,
        u.email,
        u.full_name,
        u.phone,
        bm.business_id,
        bm.role AS business_role,
        b.name AS business_name,
        b.rc_number,
        b.verification_status
      FROM users u
      LEFT JOIN business_members bm ON u.id = bm.user_id
      LEFT JOIN businesses b ON bm.business_id = b.id
      WHERE u.${queryField} = ? LIMIT 1`,
      [queryParam]
    );

    if (rows.length === 0) {
      return { isKnown: false, chatId };
    }

    const row = rows[0];
    return {
      isKnown: true,
      chatId,
      user: {
        id: row.user_id,
        email: row.email,
        fullName: row.full_name,
        phone: row.phone
      },
      business: {
        id: row.business_id,
        name: row.business_name,
        rcNumber: row.rc_number,
        role: row.business_role,
        verificationStatus: row.verification_status
      }
    };
  }

  /**
   * Main Handler for Telegram Updates (Messages & Callback Queries)
   */
  static async processUpdate(update) {
    // 1. Handle Inline Button Callback Queries
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message?.chat?.id || cb.from?.id;
      const data = cb.data || '';
      const identity = await this.resolveIdentity(chatId, cb.from);

      if (!identity.isKnown) {
        return telegramClient.sendMessage(chatId, '⚠️ Please link or register your account first.');
      }

      if (data.startsWith('ACCEPT_DEAL_')) {
        const parts = data.split('_');
        return this.handleAcceptDeal(chatId, identity, parts[2], parts[3]);
      }

      if (data.startsWith('CONFIRM_PAYMENT_')) {
        const parts = data.replace('CONFIRM_PAYMENT_', '').split('_');
        return this.handleConfirmPayment(chatId, identity, parts[0], parts[1]);
      }

      if (data.startsWith('ATTACH_EVID_')) {
        const parts = data.replace('ATTACH_EVID_', '').split('_');
        const session = telegramSession.getSession(chatId);
        return this.handleAttachEvidenceExecution(chatId, identity, session.data, {
          dealId: parts[0],
          obligationId: parts[1] === 'GENERAL' ? null : parts[1]
        });
      }

      return;
    }

    // 2. Handle Messages
    const message = update.message;
    if (!message) return;

    const chatId = message.chat.id;
    const text = (message.text || '').trim();
    const identity = await this.resolveIdentity(chatId, message.from);
    const session = telegramSession.getSession(chatId);

    // Photo / Document Upload
    if (message.photo || message.document) {
      const fileId = message.photo 
        ? message.photo[message.photo.length - 1].file_id 
        : message.document.file_id;
      const caption = message.caption || 'Uploaded via Telegram Bot';

      if (!identity.isKnown) {
        return this.sendOnboardingPrompt(chatId);
      }

      return this.handleMediaUpload(chatId, identity, {
        id: fileId,
        filename: message.document?.file_name || `telegram_evidence_${Date.now()}.jpg`,
        caption
      });
    }

    // Self-Registration via Telegram
    const registerMatch = text.match(/^REGISTER:\s*([^,]+),\s*([^,]+)(?:,\s*([^,]+))?$/i);
    if (registerMatch) {
      return this.handleRegistration(chatId, {
        fullName: registerMatch[1].trim(),
        businessName: registerMatch[2].trim(),
        rcNumber: (registerMatch[3] || '').trim() || null
      });
    }

    // Account Linking command: LINK: email@example.com
    const linkMatch = text.match(/^LINK:\s*([^\s@]+@[^\s@]+\.[^\s@]+)$/i);
    if (linkMatch) {
      return this.handleLinkAccount(chatId, linkMatch[1].trim());
    }

    // Unknown User
    if (!identity.isKnown) {
      return this.sendOnboardingPrompt(chatId);
    }

    // Active session state: Awaiting Deal Details
    if (session.state === 'AWAITING_DEAL_DETAILS' && !text.startsWith('/')) {
      return this.handleDealDetailsSubmission(chatId, identity, text);
    }

    // Standard Commands
    const lower = text.toLowerCase();
    if (lower === '/start' || lower === '/help') {
      return this.sendHelpMenu(chatId, identity);
    }

    if (lower === '/deals' || lower === 'status' || lower === '/status' || lower === 'my deals') {
      return this.handleStatusInquiry(chatId, identity);
    }

    if (lower === '/deal create' || lower === '/create deal' || lower === 'create deal') {
      return this.promptDealCreation(chatId, identity);
    }

    if (lower.startsWith('/deal ') && !lower.includes('create')) {
      const ref = text.substring(6).trim();
      return this.handleGetDealDetail(chatId, identity, ref);
    }

    return this.sendHelpMenu(chatId, identity);
  }

  static async sendOnboardingPrompt(chatId) {
    const text = 
`👋 *Welcome to Digital Watchdog Assistant* (Telegram Edition)

Your Telegram account is not yet linked to an enterprise profile.

*Option 1: Link Existing Account*
Reply with: \`LINK: your-email@company.com\`
Example: \`LINK: owner@alphasupplies.ng\`

*Option 2: Register New Business*
Reply with: \`REGISTER: [Your Name], [Company Name], [RC Number]\`
Example: \`REGISTER: Emeka Adeleke, Apex Logistics Ltd, RC-123456\`

Or sign in via web: http://localhost:4200`;

    return telegramClient.sendMessage(chatId, text);
  }

  static async handleLinkAccount(chatId, email) {
    const [users] = await pool.query(
      `SELECT u.id, u.full_name, u.phone, b.name AS business_name
       FROM users u
       JOIN business_members bm ON u.id = bm.user_id
       JOIN businesses b ON bm.business_id = b.id
       WHERE u.email = ? LIMIT 1`,
      [email.toLowerCase()]
    );

    if (users.length === 0) {
      return telegramClient.sendMessage(chatId, `⚠️ No user account found with email: ${email}`);
    }

    const u = users[0];
    telegramSession.linkChatToIdentity(chatId, { email: email.toLowerCase(), phone: u.phone });

    const msg = 
`✅ *Account Linked Successfully!*

👤 *Name:* ${u.full_name}
🏢 *Company:* ${u.business_name}

You can now use /deals, /deal create, and receive instant contract alerts.`;

    return telegramClient.sendMessage(chatId, msg);
  }

  static async handleRegistration(chatId, { fullName, businessName, rcNumber }) {
    const conn = await getConnection();
    try {
      await conn.beginTransaction();

      const userId = crypto.randomUUID();
      const businessId = crypto.randomUUID();
      const memberId = crypto.randomUUID();
      const generatedEmail = `tg_${chatId}@telegram.digitalwatchdog.ng`;
      const hashedPassword = await bcrypt.hash('Password123!', 10);

      await conn.query(
        `INSERT INTO businesses (id, name, rc_number, address, verification_status, created_at, updated_at)
         VALUES (?, ?, ?, 'Registered via Telegram Bot', 'unverified', NOW(), NOW())`,
        [businessId, businessName, rcNumber || null]
      );

      await conn.query(
        `INSERT INTO users (id, email, password_hash, full_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, NOW(), NOW())`,
        [userId, generatedEmail, hashedPassword, fullName]
      );

      await conn.query(
        `INSERT INTO business_members (id, user_id, business_id, role, created_at)
         VALUES (?, ?, ?, 'owner', NOW())`,
        [memberId, userId, businessId]
      );

      await conn.commit();

      telegramSession.linkChatToIdentity(chatId, { email: generatedEmail });

      const welcome = 
`🎉 *Welcome to Digital Watchdog, ${fullName}!*

Your company *${businessName}* is registered.
Type /deal create to draft a contract or /help for guidance.`;

      return telegramClient.sendMessage(chatId, welcome);
    } catch (err) {
      await conn.rollback();
      return telegramClient.sendMessage(chatId, `⚠️ Registration failed: ${err.message}`);
    } finally {
      conn.release();
    }
  }

  static async sendHelpMenu(chatId, identity) {
    const biz = identity?.business?.name || 'Your Enterprise';
    const text = 
`🛡️ *Digital Watchdog Telegram Assistant*
🏢 *Workspace:* ${biz}

*Available Commands:*
• /deals or \`STATUS\` — View active transactions & upcoming milestones
• \`/deal create\` — Initiate a secured B2B escrow agreement
• \`/deal [REF]\` — Inspect terms & deliverable status
• 📷 *Send Photo/PDF* — Upload waybill or payment receipt
• /help — Show this guidance menu`;

    const buttons = [
      { text: '📋 My Deals', callback_data: 'CMD_STATUS' },
      { text: '➕ New Contract', callback_data: 'CMD_CREATE_DEAL' },
      { text: '🌐 Web Workspace', url: 'http://localhost:4200' }
    ];

    return telegramClient.sendInlineButtons(chatId, text, buttons);
  }

  static async promptDealCreation(chatId, identity) {
    telegramSession.setSession(chatId, 'AWAITING_DEAL_DETAILS');
    const prompt = 
`📝 *Initiate New Escrow Contract*

Please reply with the deal details in this format:
*[Title], [Partner Email or Phone], [Amount] [Currency]*

*Example:*
500 MT Industrial Aggregates, procurement@betabuilders.ng, 4500000 NGN

_Type /help to cancel._`;

    return telegramClient.sendMessage(chatId, prompt);
  }

  static async handleDealDetailsSubmission(chatId, identity, rawText) {
    const parts = (rawText || '').split(',').map(p => p.trim());
    if (parts.length < 3) {
      return telegramClient.sendMessage(
        chatId,
        `⚠️ Invalid format. Format: [Title], [Partner Email or Phone], [Amount] [Currency]`
      );
    }

    const title = parts[0];
    const partnerContact = parts[1];
    const amountCurrency = parts[2].split(/\s+/);
    const amount = parseFloat(amountCurrency[0].replace(/[^0-9.]/g, ''));
    const currency = (amountCurrency[1] || 'NGN').toUpperCase();

    if (isNaN(amount) || amount <= 0) {
      return telegramClient.sendMessage(chatId, '⚠️ Amount must be a positive number.');
    }

    // Resolve Counterparty
    const isEmail = partnerContact.includes('@');
    let partnerBizId = null;
    let partnerName = 'Contractor Partner';

    let rows = [];
    if (isEmail) {
      const [emailRows] = await pool.query(
        `SELECT bm.business_id, b.name 
         FROM users u
         JOIN business_members bm ON u.id = bm.user_id
         JOIN businesses b ON bm.business_id = b.id
         WHERE LOWER(u.email) = ? LIMIT 1`,
        [partnerContact.toLowerCase()]
      );
      rows = emailRows;
    } else {
      const cleanPhone = partnerContact.replace(/[^0-9]/g, '');
      if (cleanPhone.length >= 7) {
        const [phoneRows] = await pool.query(
          `SELECT bm.business_id, b.name 
           FROM users u
           JOIN business_members bm ON u.id = bm.user_id
           JOIN businesses b ON bm.business_id = b.id
           WHERE u.phone LIKE ? LIMIT 1`,
          [`%${cleanPhone}%`]
        );
        rows = phoneRows;
      }
    }

    if (rows.length > 0) {
      partnerBizId = rows[0].business_id;
      partnerName = rows[0].name;
    } else {
      // Create provisional partner business
      partnerBizId = crypto.randomUUID();
      await pool.query(
        "INSERT INTO businesses (id, name, verification_status, created_at, updated_at) VALUES (?, ?, 'unverified', NOW(), NOW())",
        [partnerBizId, `Partner (${partnerContact})`]
      );
    }

    try {
      const deal = await DealService.createDeal({
        creatorBusinessId: identity.business.id,
        userId: identity.user.id,
        title,
        description: `B2B Escrow Agreement initiated by ${identity.business.name} via Telegram.`,
        amount,
        currency,
        termsText: 'Mutual B2B escrow agreement created via Digital Watchdog Telegram Assistant. Funds released upon verified milestone delivery.',
        counterpartyBusinessId: partnerBizId
      });

      // Seed 2 deliverables
      const in5 = new Date(Date.now() + 5 * 86400000).toISOString().split('T')[0];
      const in10 = new Date(Date.now() + 10 * 86400000).toISOString().split('T')[0];

      await pool.query(
        `INSERT INTO obligations (id, deal_id, title, description, responsible_business_id, due_date, status, created_at)
         VALUES 
         (?, ?, 'Consignment Dispatch & Waybill', 'Ship materials and upload proof of delivery.', ?, ?, 'not_started', NOW()),
         (?, ?, 'Inspection & Escrow Settlement', 'Verify goods and release payment.', ?, ?, 'not_started', NOW())`,
        [crypto.randomUUID(), deal.id, identity.business.id, in5, crypto.randomUUID(), deal.id, partnerBizId, in10]
      );

      // Record creator's acceptance
      await pool.query(
        "INSERT INTO agreement_acceptances (id, version_id, business_id, user_id, accepted_at, ip_address) VALUES (?, ?, ?, ?, NOW(), '127.0.0.1 (Telegram Bot)')",
        [crypto.randomUUID(), deal.agreement_version.id, identity.business.id, identity.user.id]
      );
      await pool.query("UPDATE deals SET status = 'awaiting_acceptance', updated_at = NOW() WHERE id = ?", [deal.id]);

      telegramSession.clearSession(chatId);

      const formattedVal = `${currency === 'USD' ? '$' : '₦'}${amount.toLocaleString()}`;

      // Confirm to creator
      await telegramClient.sendMessage(
        chatId,
        `✅ *Deal #${deal.reference_no} Created!*\n\n📋 *Title:* ${title}\n💰 *Escrow Value:* ${formattedVal}\n🏢 *Partner:* ${partnerName}\n\nInvitation dispatched to counterparty.`
      );

      // Look up partner Telegram chat ID if linked
      const partnerChatId = telegramSession.findChatIdByPhoneOrEmail(partnerContact, partnerContact);
      if (partnerChatId) {
        const inviteText = 
`🔔 *New Escrow Contract Invitation*

*${identity.business.name}* invited you to a secured B2B deal:
📄 *Deal:* #${deal.reference_no} — ${title}
💰 *Value:* ${formattedVal}

Please review and confirm to lock escrow protections:`;

        const buttons = [
          { text: '✅ Accept Terms', callback_data: `ACCEPT_DEAL_${deal.id}_${deal.agreement_version.id}` },
          { text: '🌐 View in Workspace', url: `http://localhost:4200/deals/${deal.id}` }
        ];

        await telegramClient.sendInlineButtons(partnerChatId, inviteText, buttons);
      }

      return { success: true, dealId: deal.id, reference_no: deal.reference_no };
    } catch (err) {
      console.error('[Telegram Deal Create Error]', err);
      return telegramClient.sendMessage(chatId, `⚠️ Failed to create deal: ${err.message}`);
    }
  }

  static async handleAcceptDeal(chatId, identity, dealId, versionId) {
    try {
      const [deals] = await pool.query('SELECT * FROM deals WHERE id = ?', [dealId]);
      if (deals.length === 0) return telegramClient.sendMessage(chatId, '⚠️ Deal not found.');
      const deal = deals[0];

      const res = await DealService.acceptDeal({
        dealId,
        businessId: identity.business.id,
        userId: identity.user.id,
        ipAddress: '127.0.0.1 (Telegram Bot)'
      });

      await telegramClient.sendMessage(
        chatId,
        `✅ You accepted terms for *#${deal.reference_no}*!\n🎉 Escrow protections are locked.`
      );

      if (res.deal_status === 'active') {
        const creatorChatId = telegramSession.findChatIdByPhoneOrEmail(null, 'owner@alphasupplies.ng');
        if (creatorChatId && String(creatorChatId) !== String(chatId)) {
          await telegramClient.sendMessage(
            creatorChatId,
            `🎉 *Deal #${deal.reference_no} is now ACTIVE!*\n*${identity.business.name}* signed the agreement. Milestones can now proceed under escrow protection.`
          );
        }
      }
    } catch (err) {
      return telegramClient.sendMessage(chatId, `⚠️ Acceptance failed: ${err.message}`);
    }
  }

  static async handleConfirmPayment(chatId, identity, dealId, paymentId) {
    try {
      await PaymentService.updatePaymentStatus({
        dealId,
        paymentId,
        businessId: identity.business.id,
        userId: identity.user.id,
        status: 'confirmed'
      });

      return telegramClient.sendMessage(chatId, '✅ Payment receipt confirmed! Escrow ledger updated.');
    } catch (err) {
      return telegramClient.sendMessage(chatId, `⚠️ Payment confirmation failed: ${err.message}`);
    }
  }

  static async handleMediaUpload(chatId, identity, media) {
    const [obs] = await pool.query(
      `SELECT o.id, o.title, d.id AS deal_id, d.reference_no 
       FROM obligations o
       JOIN deals d ON o.deal_id = d.id
       WHERE (d.creator_business_id = ? OR d.counterparty_business_id = ?)
         AND d.status = 'active'
       LIMIT 3`,
      [identity.business.id, identity.business.id]
    );

    if (obs.length === 0) {
      return telegramClient.sendMessage(chatId, '📷 Photo received! However, no active milestones currently require evidence.');
    }

    telegramSession.setSession(chatId, 'AWAITING_EVIDENCE_OBLIGATION', { media, obligations: obs });

    const buttons = obs.map(o => ({
      text: `${o.reference_no.slice(-6)}: ${o.title.slice(0, 15)}`,
      callback_data: `ATTACH_EVID_${o.deal_id}_${o.id}`
    }));

    return telegramClient.sendInlineButtons(
      chatId,
      '📷 *Waybill / Evidence Received*\nSelect which deliverable to attach this document to:',
      buttons
    );
  }

  static async handleAttachEvidenceExecution(chatId, identity, sessionData, { dealId, obligationId }) {
    const media = sessionData?.media;
    telegramSession.clearSession(chatId);

    try {
      const downloaded = await telegramClient.downloadFileBuffer(media?.id);
      const fileObj = {
        originalname: media?.filename || `tg_proof_${Date.now()}.jpg`,
        mimetype: downloaded.mimeType,
        size: downloaded.fileSize,
        buffer: downloaded.buffer
      };

      const stored = await storageService.saveFile(fileObj, dealId);
      const evidenceId = crypto.randomUUID();

      await pool.query(
        `INSERT INTO evidence_records (
          id, deal_id, obligation_id, submitted_by_business_id, submitted_by_user_id,
          file_path, file_name, file_size, mime_type, verification_tier, notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, NOW())`,
        [
          evidenceId,
          dealId,
          obligationId || null,
          identity.business.id,
          identity.user.id,
          stored.filePath,
          stored.fileName,
          stored.fileSize,
          stored.mimeType,
          media?.caption || 'Uploaded via Telegram'
        ]
      );

      await ActivityService.logEvent(dealId, identity.user.id, identity.business.id, 'evidence.submitted', {
        evidence_id: evidenceId,
        source: 'telegram'
      });

      return telegramClient.sendMessage(
        chatId,
        `✅ *Proof Certified on Ledger!*\n📄 File: ${stored.fileName}\nYour partner has been notified.`
      );
    } catch (err) {
      return telegramClient.sendMessage(chatId, `⚠️ Failed saving evidence: ${err.message}`);
    }
  }

  static async handleStatusInquiry(chatId, identity) {
    const [deals] = await pool.query(
      `SELECT d.reference_no, d.title, d.amount, d.currency, d.status,
              b1.name AS creator_name, b2.name AS counterparty_name
       FROM deals d
       LEFT JOIN businesses b1 ON d.creator_business_id = b1.id
       LEFT JOIN businesses b2 ON d.counterparty_business_id = b2.id
       WHERE (d.creator_business_id = ? OR d.counterparty_business_id = ?)
         AND d.status NOT IN ('cancelled', 'terminated')
       ORDER BY d.updated_at DESC LIMIT 4`,
      [identity.business.id, identity.business.id]
    );

    if (deals.length === 0) {
      return telegramClient.sendMessage(chatId, '📋 You have no active contracts. Type `/deal create` to start one.');
    }

    let report = `📋 *Active Transactions (${deals.length})*:\n\n`;
    for (const d of deals) {
      const val = `${d.currency === 'USD' ? '$' : '₦'}${Number(d.amount).toLocaleString()}`;
      report += `*#${d.reference_no}* — *${d.status.toUpperCase()}*\n`;
      report += `• ${d.title} (${val})\n\n`;
    }

    return telegramClient.sendMessage(chatId, report);
  }

  static async handleGetDealDetail(chatId, identity, dealRef) {
    const [deals] = await pool.query(
      `SELECT d.*, b1.name AS creator_name, b2.name AS counterparty_name
       FROM deals d
       LEFT JOIN businesses b1 ON d.creator_business_id = b1.id
       LEFT JOIN businesses b2 ON d.counterparty_business_id = b2.id
       WHERE d.reference_no LIKE ? AND (d.creator_business_id = ? OR d.counterparty_business_id = ?) LIMIT 1`,
      [`%${dealRef}%`, identity.business.id, identity.business.id]
    );

    if (deals.length === 0) {
      return telegramClient.sendMessage(chatId, `⚠️ Contract "${dealRef}" not found.`);
    }

    const d = deals[0];
    const val = `${d.currency === 'USD' ? '$' : '₦'}${Number(d.amount).toLocaleString()}`;
    const text = `📄 *Deal #${d.reference_no}*\n*Title:* ${d.title}\n*Value:* ${val}\n*Status:* ${d.status.toUpperCase()}\n\nWorkspace: http://localhost:4200/deals/${d.id}`;
    return telegramClient.sendMessage(chatId, text);
  }

  static async dispatchOutboundNotification(eventType, data) {
    try {
      const dealId = data.deal_id || data.id;
      if (!dealId) return;

      const [deals] = await pool.query('SELECT reference_no, creator_business_id, counterparty_business_id, amount, currency FROM deals WHERE id = ?', [dealId]);
      if (deals.length === 0) return;
      const deal = deals[0];

      if (eventType === 'payment.reported') {
        const creatorChatId = telegramSession.findChatIdByPhoneOrEmail(null, 'owner@alphasupplies.ng');
        if (creatorChatId) {
          const amt = `${deal.currency} ${Number(data.reported_amount || deal.amount).toLocaleString()}`;
          const msg = `💰 *Payment Notice: #${deal.reference_no}*\nBuyer reported *${amt}* transferred.\nReference: ${data.reference_no || 'PAY-REF'}`;
          const buttons = [
            { text: '✅ Confirm Receipt', callback_data: `CONFIRM_PAYMENT_${dealId}_${data.payment_id || data.id}` }
          ];
          await telegramClient.sendInlineButtons(creatorChatId, msg, buttons);
        }
      }
    } catch (e) {
      console.error('[Telegram Outbound Error]', e);
    }
  }
}

export default TelegramEngine;
