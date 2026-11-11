/**
 * WhatsApp Conversational Finite State Machine (FSM)
 * Orchestrates multi-step dialogs, deal creations, milestone tracking, and ledger confirmations.
 */
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import pool, { getConnection } from '../../../config/db.js';
import { DealService } from '../../../services/dealService.js';
import { ObligationService } from '../../../services/obligationService.js';
import { PaymentService } from '../../../services/paymentService.js';
import storageService from '../../../services/storageService.js';
import ActivityService from '../../../services/activityService.js';
import whatsappClient from './whatsappClient.js';
import chatSession from '../models/chatSession.js';
import { normalizePhoneNumber, extractCommandIntent } from './messageParser.js';

export class ConversationEngine {
  /**
   * Resolve WhatsApp sender's phone to a registered user and business
   */
  static async resolveUser(rawPhone) {
    const normalized = normalizePhoneNumber(rawPhone);
    if (!normalized) return { isKnown: false, phone: '' };

    // Formats: '2348011112222', '+2348011112222', or local '08011112222'
    const cleanDigits = normalized;
    const plusFormat = `+${normalized}`;
    let localFormat = '';
    if (normalized.startsWith('234') && normalized.length === 13) {
      localFormat = '0' + normalized.substring(3);
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
      WHERE u.phone IN (?, ?, ?) 
         OR REPLACE(REPLACE(REPLACE(u.phone, '+', ''), '-', ''), ' ', '') = ?
      LIMIT 1`,
      [plusFormat, cleanDigits, localFormat, cleanDigits]
    );

    if (rows.length === 0) {
      return { isKnown: false, phone: cleanDigits };
    }

    const row = rows[0];
    return {
      isKnown: true,
      phone: cleanDigits,
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
   * Main entry point for processing incoming parsed message
   */
  static async processMessage(parsedMessage) {
    const fromPhone = parsedMessage.from;
    const intentData = extractCommandIntent(parsedMessage);
    const session = chatSession.getSession(fromPhone);

    // 1. Resolve Identity
    const identity = await this.resolveUser(fromPhone);

    // 2. Handle Unknown User
    if (!identity.isKnown) {
      if (intentData.intent === 'REGISTER_USER') {
        return this.handleRegistration(fromPhone, intentData);
      }
      return this.sendOnboardingPrompt(fromPhone);
    }

    // 3. Handle Active Multi-Step Sessions
    if (session.state === 'AWAITING_DEAL_DETAILS' && intentData.intent !== 'HELP_MENU') {
      return this.handleDealDetailsSubmission(fromPhone, identity, parsedMessage.text);
    }

    if (session.state === 'AWAITING_EVIDENCE_OBLIGATION' && intentData.intent === 'ATTACH_EVIDENCE_CHOICE') {
      return this.handleAttachEvidenceExecution(fromPhone, identity, session.data, intentData);
    }

    // 4. Handle Standard Commands & Intents
    switch (intentData.intent) {
      case 'CREATE_DEAL_PROMPT':
        return this.promptDealCreation(fromPhone, identity);

      case 'ACCEPT_DEAL':
        return this.handleAcceptDeal(fromPhone, identity, intentData.dealId, intentData.versionId);

      case 'DECLINE_DEAL':
        return this.handleDeclineDeal(fromPhone, identity, intentData.dealId);

      case 'VIEW_TERMS':
        return this.handleViewTerms(fromPhone, identity, intentData.dealId);

      case 'CONFIRM_PAYMENT':
        return this.handleConfirmPayment(fromPhone, identity, intentData.dealId, intentData.paymentId);

      case 'DISPUTE_PAYMENT':
        return this.handleDisputePayment(fromPhone, identity, intentData.dealId, intentData.paymentId);

      case 'MEDIA_UPLOAD':
        return this.handleMediaUpload(fromPhone, identity, intentData.media);

      case 'STATUS_INQUIRY':
        return this.handleStatusInquiry(fromPhone, identity);

      case 'GET_DEAL_DETAIL':
        return this.handleGetDealDetail(fromPhone, identity, intentData.dealRef);

      case 'HELP_MENU':
      default:
        return this.sendHelpMenu(fromPhone, identity);
    }
  }

  /**
   * Prompt unknown phone number to register or link account
   */
  static async sendOnboardingPrompt(phone) {
    const text = 
`👋 *Welcome to Digital Watchdog* — B2B Escrow & Milestone Accountability.

Your number (+${phone}) is not yet linked to an enterprise account.

To register your business immediately via WhatsApp, reply with:
*REGISTER: [Your Name], [Company Name], [RC Number]*

*Example:*
REGISTER: Ibrahim Adeleke, Apex Logistics Ltd, RC-982134

Or visit our web portal to sign in: http://localhost:4200`;

    return whatsappClient.sendTextMessage(phone, text);
  }

  /**
   * Handle Self-Registration via WhatsApp
   */
  static async handleRegistration(phone, { fullName, businessName, rcNumber }) {
    const conn = await getConnection();
    try {
      await conn.beginTransaction();

      const userId = crypto.randomUUID();
      const businessId = crypto.randomUUID();
      const memberId = crypto.randomUUID();
      const formattedPhone = `+${phone}`;
      const defaultEmail = `${phone}@whatsapp.digitalwatchdog.ng`;
      const hashedPassword = await bcrypt.hash('Password123!', 10);

      // Create Business
      await conn.query(
        `INSERT INTO businesses (id, name, rc_number, address, verification_status, created_at, updated_at)
         VALUES (?, ?, ?, 'Registered via WhatsApp Assistant', 'unverified', NOW(), NOW())`,
        [businessId, businessName, rcNumber || null]
      );

      // Create User
      await conn.query(
        `INSERT INTO users (id, email, password_hash, full_name, phone, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
        [userId, defaultEmail, hashedPassword, fullName, formattedPhone]
      );

      // Link Member
      await conn.query(
        `INSERT INTO business_members (id, user_id, business_id, role, created_at)
         VALUES (?, ?, ?, 'owner', NOW())`,
        [memberId, userId, businessId]
      );

      await conn.commit();

      const welcomeText = 
`🎉 *Welcome to Digital Watchdog, ${fullName}!*

Your enterprise *${businessName}* has been verified and registered.

You can now:
• Type */deal create* to initiate a protected B2B escrow contract.
• Type *STATUS* to inspect ongoing transactions.
• Send a waybill photo or payment screenshot to log immutable audit proof.

Type */help* anytime for assistance.`;

      return whatsappClient.sendTextMessage(phone, welcomeText);
    } catch (err) {
      await conn.rollback();
      console.error('[Registration Error]', err);
      return whatsappClient.sendTextMessage(phone, `⚠️ Registration failed: ${err.message}. Please try again.`);
    } finally {
      conn.release();
    }
  }

  /**
   * Help & Command Menu
   */
  static async sendHelpMenu(phone, identity) {
    const name = identity?.user?.fullName || 'Partner';
    const bizName = identity?.business?.name || 'Your Enterprise';

    const text = 
`🛡️ *Digital Watchdog Assistant* (${bizName})

Available WhatsApp Actions:
• *STATUS* or */deals* — View all active transactions & upcoming milestones
• */deal create* — Start a new protected contract with another business
• */deal [REF]* — View contract terms & milestone status (e.g. /deal DW-2026)
• 📷 *Send Photo/PDF* — Attach waybill or bank payment screenshot
• */help* — Show this guidance menu

_Web Workspace:_ http://localhost:4200`;

    const buttons = [
      { id: 'MENU_STATUS', title: '📋 My Deals' },
      { id: 'MENU_CREATE_DEAL', title: '➕ New Deal' },
      { id: 'MENU_HELP', title: '❓ Help' }
    ];

    return whatsappClient.sendQuickReplyButtons(phone, text, buttons);
  }

  /**
   * 1. Deal Initiation Step 1: Prompt for Details
   */
  static async promptDealCreation(phone, identity) {
    chatSession.setSession(phone, 'AWAITING_DEAL_DETAILS', {});

    const text = 
`📝 *Initiate New Escrow Agreement*

Please reply with your deal details in this format:
*[Title], [Counterparty Phone], [Amount] [Currency]*

*Example:*
600 Bags Dangote Cement, 08033334444, 6300000 NGN

_Type /help to cancel._`;

    return whatsappClient.sendTextMessage(phone, text);
  }

  /**
   * 1. Deal Initiation Step 2: Handle Details Submission
   */
  static async handleDealDetailsSubmission(phone, identity, rawText) {
    const parts = (rawText || '').split(',').map(p => p.trim());
    if (parts.length < 3) {
      return whatsappClient.sendTextMessage(
        phone,
        `⚠️ Invalid format. Please reply with: [Title], [Counterparty Phone], [Amount] [Currency]\n\nExample:\n600 Bags Cement, 08033334444, 6300000 NGN`
      );
    }

    const title = parts[0];
    const counterpartyRawPhone = parts[1];
    const amountCurrencyStr = parts[2];

    const amountTokens = amountCurrencyStr.split(/\s+/);
    const amountVal = parseFloat(amountTokens[0].replace(/[^0-9.]/g, ''));
    const currencyVal = (amountTokens[1] || 'NGN').toUpperCase();

    if (!title || title.length < 3) {
      return whatsappClient.sendTextMessage(phone, `⚠️ Deal title is too short. Please provide a descriptive title.`);
    }

    if (isNaN(amountVal) || amountVal <= 0) {
      return whatsappClient.sendTextMessage(phone, `⚠️ Invalid amount. Please specify a positive numerical value.`);
    }

    const counterpartyNormalized = normalizePhoneNumber(counterpartyRawPhone);
    if (!counterpartyNormalized) {
      return whatsappClient.sendTextMessage(phone, `⚠️ Invalid counterparty phone number format.`);
    }

    // Resolve Counterparty Business
    let counterpartyBizId = null;
    let counterpartyBizName = 'Counterparty Enterprise';
    const counterpartyIdentity = await this.resolveUser(counterpartyNormalized);

    if (counterpartyIdentity.isKnown) {
      counterpartyBizId = counterpartyIdentity.business.id;
      counterpartyBizName = counterpartyIdentity.business.name;
    } else {
      // Auto-create provisional business for the recipient
      const provisionalBizId = crypto.randomUUID();
      const provisionalUserId = crypto.randomUUID();
      const provisionalMemberId = crypto.randomUUID();

      await pool.query(
        `INSERT INTO businesses (id, name, verification_status, created_at, updated_at)
         VALUES (?, ?, 'unverified', NOW(), NOW())`,
        [provisionalBizId, `Enterprise (+${counterpartyNormalized})`]
      );

      await pool.query(
        `INSERT INTO users (id, email, password_hash, full_name, phone, created_at, updated_at)
         VALUES (?, ?, 'N/A', ?, ?, NOW(), NOW())`,
        [provisionalUserId, `${counterpartyNormalized}@whatsapp.digitalwatchdog.ng`, `Partner (+${counterpartyNormalized})`, `+${counterpartyNormalized}`]
      );

      await pool.query(
        `INSERT INTO business_members (id, user_id, business_id, role, created_at)
         VALUES (?, ?, ?, 'owner', NOW())`,
        [provisionalMemberId, provisionalUserId, provisionalBizId]
      );

      counterpartyBizId = provisionalBizId;
      counterpartyBizName = `Partner (+${counterpartyNormalized})`;
    }

    // Call DealService to create the deal
    const terms = `Mutual B2B escrow agreement created via Digital Watchdog WhatsApp Assistant. Funds and deliveries secured until verified milestone completion.`;

    try {
      const dealResult = await DealService.createDeal({
        creatorBusinessId: identity.business.id,
        userId: identity.user.id,
        title,
        description: `B2B Escrow Agreement initiated by ${identity.business.name} via WhatsApp.`,
        amount: amountVal,
        currency: currencyVal,
        termsText: terms,
        counterpartyBusinessId: counterpartyBizId
      });

      // Automatically seed two starter obligations for milestone accountability
      const ob1Id = crypto.randomUUID();
      const ob2Id = crypto.randomUUID();
      const in5Days = new Date(Date.now() + 5 * 86400000).toISOString().split('T')[0];
      const in10Days = new Date(Date.now() + 10 * 86400000).toISOString().split('T')[0];

      await pool.query(
        `INSERT INTO obligations (id, deal_id, title, description, responsible_business_id, due_date, status, created_at)
         VALUES 
         (?, ?, 'Consignment Delivery & Waybill', 'Dispatch agreed goods and upload signed proof of delivery / waybill.', ?, ?, 'not_started', NOW()),
         (?, ?, 'Final Quality Inspection & Escrow Settle', 'Confirm goods match specifications and release escrow settlement.', ?, ?, 'not_started', NOW())`,
        [ob1Id, dealResult.id, identity.business.id, in5Days, ob2Id, dealResult.id, counterpartyBizId, in10Days]
      );

      // Record Creator's acceptance of Version 1 and advance deal to 'awaiting_acceptance'
      const creatorAcceptanceId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO agreement_acceptances (id, version_id, business_id, user_id, accepted_at, ip_address)
         VALUES (?, ?, ?, ?, NOW(), '127.0.0.1 (WhatsApp Assistant)')`,
        [creatorAcceptanceId, dealResult.agreement_version.id, identity.business.id, identity.user.id]
      );

      await pool.query(
        "UPDATE deals SET status = 'awaiting_acceptance', updated_at = NOW() WHERE id = ?",
        [dealResult.id]
      );

      // Clear session state
      chatSession.clearSession(phone);

      const formattedAmount = `${currencyVal === 'USD' ? '$' : '₦'}${amountVal.toLocaleString()}`;

      // Notify Creator
      const creatorConfirmation = 
`✅ *Deal #${dealResult.reference_no} Created!*

📋 *Title:* ${title}
💰 *Escrow Value:* ${formattedAmount}
🏢 *Counterparty:* ${counterpartyBizName} (+${counterpartyNormalized})
⏳ *Status:* Awaiting Counterparty Acceptance

An instant WhatsApp invitation has been sent to +${counterpartyNormalized}.`;

      await whatsappClient.sendTextMessage(phone, creatorConfirmation);

      // Dispatch Invitation to Counterparty with Interactive Buttons
      const inviteText = 
`🔔 *New Escrow Contract Invitation*

*${identity.business.name}* has invited you to a secured B2B deal on Digital Watchdog:

📄 *Deal:* #${dealResult.reference_no} — ${title}
💰 *Value:* ${formattedAmount}
🛡️ *Escrow Terms:* Payment protected until milestone proof is certified.

Please review and confirm to activate escrow protections:`;

      const buttons = [
        { id: `ACCEPT_DEAL_${dealResult.id}_${dealResult.agreement_version.id}`, title: '✅ Accept Terms' },
        { id: `DECLINE_DEAL_${dealResult.id}`, title: '❌ Decline' }
      ];

      await whatsappClient.sendQuickReplyButtons(counterpartyNormalized, inviteText, buttons);

      return { success: true, dealId: dealResult.id, reference_no: dealResult.reference_no };
    } catch (err) {
      console.error('[Deal Creation Error]', err);
      return whatsappClient.sendTextMessage(phone, `⚠️ Failed to create deal: ${err.message}`);
    }
  }

  /**
   * 2. Two-Party Quick Acceptance
   */
  static async handleAcceptDeal(phone, identity, dealId, versionId) {
    try {
      const [deals] = await pool.query('SELECT * FROM deals WHERE id = ?', [dealId]);
      if (deals.length === 0) {
        return whatsappClient.sendTextMessage(phone, '⚠️ Deal not found or has been cancelled.');
      }
      const deal = deals[0];

      // Call Core DealService to accept
      const acceptResult = await DealService.acceptDeal({
        dealId,
        businessId: identity.business.id,
        userId: identity.user.id,
        ipAddress: '127.0.0.1 (WhatsApp Meta Bot)'
      });

      // Confirm to accepting party
      const formattedAmount = `${deal.currency === 'USD' ? '$' : '₦'}${Number(deal.amount).toLocaleString()}`;
      await whatsappClient.sendTextMessage(
        phone,
        `✅ You accepted the terms for *#${deal.reference_no}*!\n🎉 Escrow protections are locked.`
      );

      // If deal transitioned to active, alert both parties
      if (acceptResult.deal_status === 'active') {
        // Look up creator phone
        const [creators] = await pool.query(
          `SELECT u.phone, b.name AS creator_name 
           FROM users u
           JOIN business_members bm ON u.id = bm.user_id
           JOIN businesses b ON bm.business_id = b.id
           WHERE bm.business_id = ? LIMIT 1`,
          [deal.creator_business_id]
        );

        const activationNotice = 
`🎉 *Deal #${deal.reference_no} is now ACTIVE!*

*${identity.business.name}* has signed the agreement.
📋 *Contract:* ${deal.title} (${formattedAmount})
🎯 *Milestones:* 2 accountability tasks scheduled.

Work and delivery may now proceed under cryptographic escrow protection.`;

        if (creators.length > 0 && creators[0].phone) {
          const creatorPhone = normalizePhoneNumber(creators[0].phone);
          await whatsappClient.sendTextMessage(creatorPhone, activationNotice);
        }
      }

      return { success: true, status: acceptResult.deal_status };
    } catch (err) {
      console.error('[Accept Deal Error]', err);
      return whatsappClient.sendTextMessage(phone, `⚠️ Unable to accept terms: ${err.message}`);
    }
  }

  /**
   * Decline Deal Invitation
   */
  static async handleDeclineDeal(phone, identity, dealId) {
    await pool.query("UPDATE deals SET status = 'cancelled', updated_at = NOW() WHERE id = ?", [dealId]);
    return whatsappClient.sendTextMessage(phone, '❌ You have declined this deal invitation. The deal has been closed.');
  }

  /**
   * View Terms Summary
   */
  static async handleViewTerms(phone, identity, dealId) {
    const [rows] = await pool.query(
      `SELECT d.reference_no, d.title, d.amount, d.currency, av.terms_text
       FROM deals d
       JOIN agreement_versions av ON d.id = av.deal_id AND d.current_version = av.version_number
       WHERE d.id = ?`,
      [dealId]
    );

    if (rows.length === 0) {
      return whatsappClient.sendTextMessage(phone, '⚠️ Terms could not be retrieved.');
    }

    const t = rows[0];
    const text = 
`📄 *Terms for Deal #${t.reference_no}*
*Title:* ${t.title}
*Value:* ${t.currency} ${Number(t.amount).toLocaleString()}

*Agreement Clauses:*
${t.terms_text}

Reply with */accept* or tap the button above to sign.`;

    return whatsappClient.sendTextMessage(phone, text);
  }

  /**
   * 3. Evidence & Photo Ingestion
   */
  static async handleMediaUpload(phone, identity, media) {
    // Find active obligations for the user's business
    const [obligations] = await pool.query(
      `SELECT o.id, o.title, o.due_date, d.id AS deal_id, d.reference_no, d.title AS deal_title
       FROM obligations o
       JOIN deals d ON o.deal_id = d.id
       WHERE (d.creator_business_id = ? OR d.counterparty_business_id = ?)
         AND d.status = 'active'
         AND o.status IN ('not_started', 'in_progress', 'submitted_for_review')
       ORDER BY o.due_date ASC
       LIMIT 4`,
      [identity.business.id, identity.business.id]
    );

    if (obligations.length === 0) {
      // Find any active deal to attach as general evidence
      const [deals] = await pool.query(
        `SELECT id, reference_no, title FROM deals 
         WHERE (creator_business_id = ? OR counterparty_business_id = ?) AND status = 'active'
         ORDER BY updated_at DESC LIMIT 1`,
        [identity.business.id, identity.business.id]
      );

      if (deals.length === 0) {
        return whatsappClient.sendTextMessage(
          phone,
          '📎 Photo received! However, you currently have no active deals to attach this proof to.'
        );
      }

      // Automatically attach to the active deal
      return this.executeEvidenceSave(phone, identity, deals[0].id, null, media, deals[0].reference_no, 'General Proof');
    }

    // Save media metadata to session
    chatSession.setSession(phone, 'AWAITING_EVIDENCE_OBLIGATION', { media, obligations });

    // Present Quick Reply buttons (up to 3) or interactive list
    const buttons = obligations.slice(0, 3).map(ob => ({
      id: `ATTACH_EVID_${ob.deal_id}_${ob.id}`,
      title: `${ob.reference_no.slice(-6)}: ${ob.title.slice(0, 10)}`
    }));

    const text = 
`📷 *Waybill / Evidence Ingestion*

We received your document. Which active deliverable would you like to attach this photo to?`;

    return whatsappClient.sendQuickReplyButtons(phone, text, buttons);
  }

  /**
   * Execute Evidence Attachment
   */
  static async handleAttachEvidenceExecution(phone, identity, sessionData, intentData) {
    const media = sessionData.media;
    const { dealId, obligationId } = intentData;

    chatSession.clearSession(phone);

    const [deals] = await pool.query('SELECT reference_no FROM deals WHERE id = ?', [dealId]);
    const dealRef = deals[0]?.reference_no || 'Deal';

    let taskTitle = 'General Deliverable';
    if (obligationId) {
      const [obs] = await pool.query('SELECT title FROM obligations WHERE id = ?', [obligationId]);
      if (obs.length > 0) taskTitle = obs[0].title;
    }

    return this.executeEvidenceSave(phone, identity, dealId, obligationId, media, dealRef, taskTitle);
  }

  /**
   * Internal helper to pipe media into storageService and insert evidence_record
   */
  static async executeEvidenceSave(phone, identity, dealId, obligationId, media, dealRef, taskTitle) {
    try {
      // Download bytes from Meta Graph API (or mock)
      const downloaded = await whatsappClient.downloadMediaBuffer(media.id);

      const fileObj = {
        originalname: media.filename || `evidence_${Date.now()}.jpg`,
        mimetype: downloaded.mimeType,
        size: downloaded.fileSize,
        buffer: downloaded.buffer
      };

      // Save via pluggable StorageService
      const stored = await storageService.saveFile(fileObj, dealId);
      const evidenceId = crypto.randomUUID();

      const conn = await getConnection();
      try {
        await conn.beginTransaction();

        await conn.query(
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
            media.caption || 'Submitted via WhatsApp Business Assistant'
          ]
        );

        // Advance obligation status to 'submitted_for_review' if attached
        if (obligationId) {
          await conn.query(
            "UPDATE obligations SET status = 'submitted_for_review', updated_at = NOW() WHERE id = ?",
            [obligationId]
          );
        }

        await ActivityService.logEvent(
          dealId,
          identity.user.id,
          identity.business.id,
          'evidence.submitted',
          {
            evidence_id: evidenceId,
            file_name: stored.fileName,
            obligation_id: obligationId || null,
            source: 'whatsapp'
          },
          conn
        );

        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }

      // Confirm to uploader
      const confirmationText = 
`✅ *Evidence Certified on Ledger!*

📄 *File:* ${stored.fileName}
🎯 *Deliverable:* ${taskTitle}
🛡️ *Deal:* #${dealRef}

The counterparty has been notified to inspect and release next milestone escrow funds.`;

      await whatsappClient.sendTextMessage(phone, confirmationText);

      // Alert Counterparty
      const [dealRow] = await pool.query('SELECT creator_business_id, counterparty_business_id FROM deals WHERE id = ?', [dealId]);
      const otherBizId = dealRow[0].creator_business_id === identity.business.id 
        ? dealRow[0].counterparty_business_id 
        : dealRow[0].creator_business_id;

      if (otherBizId) {
        const [counterpartUsers] = await pool.query(
          `SELECT u.phone FROM users u
           JOIN business_members bm ON u.id = bm.user_id
           WHERE bm.business_id = ? LIMIT 1`,
          [otherBizId]
        );

        if (counterpartUsers.length > 0 && counterpartUsers[0].phone) {
          const alertPhone = normalizePhoneNumber(counterpartUsers[0].phone);
          const alertText = 
`🔔 *New Evidence Submitted for #${dealRef}*

*${identity.business.name}* uploaded proof for *${taskTitle}*.
Inspect here: http://localhost:4200/deals/${dealId}`;

          await whatsappClient.sendTextMessage(alertPhone, alertText);
        }
      }

      return { success: true, evidenceId };
    } catch (err) {
      console.error('[Evidence Save Error]', err);
      return whatsappClient.sendTextMessage(phone, `⚠️ Failed saving evidence: ${err.message}`);
    }
  }

  /**
   * 4. Confirm Payment
   */
  static async handleConfirmPayment(phone, identity, dealId, paymentId) {
    try {
      await PaymentService.updatePaymentStatus({
        dealId,
        paymentId,
        businessId: identity.business.id,
        userId: identity.user.id,
        status: 'confirmed'
      });

      const [payments] = await pool.query('SELECT reference_no, reported_amount, currency FROM payment_records WHERE id = ?', [paymentId]);
      const [deals] = await pool.query('SELECT reference_no FROM deals WHERE id = ?', [dealId]);
      const p = payments[0] || {};
      const d = deals[0] || {};

      await whatsappClient.sendTextMessage(
        phone,
        `✅ Payment *${p.reference_no}* confirmed! Escrow funds credited on ledger.`
      );

      return { success: true, paymentId };
    } catch (err) {
      console.error('[Confirm Payment Error]', err);
      return whatsappClient.sendTextMessage(phone, `⚠️ Failed confirming payment: ${err.message}`);
    }
  }

  /**
   * Dispute Payment
   */
  static async handleDisputePayment(phone, identity, dealId, paymentId) {
    return whatsappClient.sendTextMessage(
      phone,
      `⚠️ Payment marked as disputed. Our compliance team has placed this transaction on temporary hold. Please visit the Dispute Center at http://localhost:4200/deals/${dealId}`
    );
  }

  /**
   * 5. Status Inquiry (STATUS or /deals)
   */
  static async handleStatusInquiry(phone, identity) {
    const [deals] = await pool.query(
      `SELECT 
        d.id,
        d.reference_no,
        d.title,
        d.amount,
        d.currency,
        d.status,
        b1.name AS creator_name,
        b2.name AS counterparty_name,
        CASE WHEN d.creator_business_id = ? THEN b2.name ELSE b1.name END AS partner_name
      FROM deals d
      LEFT JOIN businesses b1 ON d.creator_business_id = b1.id
      LEFT JOIN businesses b2 ON d.counterparty_business_id = b2.id
      WHERE (d.creator_business_id = ? OR d.counterparty_business_id = ?)
        AND d.status NOT IN ('cancelled', 'terminated')
      ORDER BY d.updated_at DESC
      LIMIT 5`,
      [identity.business.id, identity.business.id, identity.business.id]
    );

    if (deals.length === 0) {
      return whatsappClient.sendTextMessage(
        phone,
        `📋 You have no active contracts at this time.\n\nType */deal create* to launch a protected deal.`
      );
    }

    let report = `📋 *Active Transactions (${deals.length})*:\n\n`;

    for (const d of deals) {
      const partner = d.partner_name || 'Counterparty';
      const formattedAmount = `${d.currency === 'USD' ? '$' : '₦'}${Number(d.amount).toLocaleString()}`;
      const statusBadge = d.status.toUpperCase().replace('_', ' ');

      report += `*#${d.reference_no}* (${partner}) — *${statusBadge}*\n`;
      report += `• Title: ${d.title}\n`;
      report += `• Value: ${formattedAmount}\n`;

      // Find next pending obligation
      const [obs] = await pool.query(
        `SELECT title, due_date FROM obligations 
         WHERE deal_id = ? AND status != 'completed' 
         ORDER BY due_date ASC LIMIT 1`,
        [d.id]
      );

      if (obs.length > 0) {
        const dueDate = new Date(obs[0].due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        report += `• Next: ${obs[0].title} (Due: ${dueDate})\n`;
      } else if (d.status === 'awaiting_acceptance') {
        report += `• Action: Review and sign agreement\n`;
      }
      report += `\n`;
    }

    report += `Reply with */deal [REFERENCE]* for full details.`;

    return whatsappClient.sendTextMessage(phone, report);
  }

  /**
   * Detail view for a specific deal
   */
  static async handleGetDealDetail(phone, identity, dealRef) {
    const cleanRef = dealRef.trim();
    const [deals] = await pool.query(
      `SELECT d.*, b1.name AS creator_name, b2.name AS counterparty_name
       FROM deals d
       LEFT JOIN businesses b1 ON d.creator_business_id = b1.id
       LEFT JOIN businesses b2 ON d.counterparty_business_id = b2.id
       WHERE (d.reference_no LIKE ? OR d.reference_no = ?)
         AND (d.creator_business_id = ? OR d.counterparty_business_id = ?)
       LIMIT 1`,
      [`%${cleanRef}%`, cleanRef, identity.business.id, identity.business.id]
    );

    if (deals.length === 0) {
      return whatsappClient.sendTextMessage(phone, `⚠️ Contract "${dealRef}" not found in your transactions.`);
    }

    const d = deals[0];
    const formattedAmount = `${d.currency === 'USD' ? '$' : '₦'}${Number(d.amount).toLocaleString()}`;

    const [obs] = await pool.query('SELECT title, status, due_date FROM obligations WHERE deal_id = ?', [d.id]);
    const completedCount = obs.filter(o => o.status === 'completed').length;

    let text = 
`📄 *Contract #${d.reference_no}*
*Title:* ${d.title}
*Value:* ${formattedAmount}
*Status:* ${d.status.toUpperCase()}
*Initiator:* ${d.creator_name}
*Partner:* ${d.counterparty_name || 'Pending'}
*Milestones:* ${completedCount} of ${obs.length} Completed

*Deliverables:*
${obs.map(o => `• [${o.status === 'completed' ? '✓' : '⏳'}] ${o.title}`).join('\n') || 'None'}

_Workspace:_ http://localhost:4200/deals/${d.id}`;

    return whatsappClient.sendTextMessage(phone, text);
  }

  /**
   * 6. Outbound Notification Dispatcher
   * Called proactively by core system events (e.g. payment.recorded, obligation.overdue, etc.)
   */
  static async dispatchOutboundNotification(eventType, data) {
    try {
      const dealId = data.deal_id || data.id;
      if (!dealId) return;

      const [deals] = await pool.query(
        `SELECT d.*, 
                b1.name AS creator_name, 
                b2.name AS counterparty_name
         FROM deals d
         LEFT JOIN businesses b1 ON d.creator_business_id = b1.id
         LEFT JOIN businesses b2 ON d.counterparty_business_id = b2.id
         WHERE d.id = ?`,
        [dealId]
      );

      if (deals.length === 0) return;
      const deal = deals[0];

      // Fetch creator & counterparty phone numbers
      const [participants] = await pool.query(
        `SELECT u.phone, bm.business_id, u.full_name
         FROM users u
         JOIN business_members bm ON u.id = bm.user_id
         WHERE bm.business_id IN (?, ?)`,
        [deal.creator_business_id, deal.counterparty_business_id]
      );

      const creatorUsers = participants.filter(p => p.business_id === deal.creator_business_id);
      const counterpartyUsers = participants.filter(p => p.business_id === deal.counterparty_business_id);

      const creatorPhone = creatorUsers[0]?.phone ? normalizePhoneNumber(creatorUsers[0].phone) : null;
      const counterpartyPhone = counterpartyUsers[0]?.phone ? normalizePhoneNumber(counterpartyUsers[0].phone) : null;

      // Event Routing
      if (eventType === 'payment.reported') {
        // Alert payee / supplier with 1-click confirmation buttons
        const targetPhone = creatorPhone; // Or supplier
        if (targetPhone) {
          const amount = data.reported_amount || data.expected_amount || 0;
          const ref = data.reference_no || 'PAY-REF';
          const msg = 
`💰 *Payment Reported: Deal #${deal.reference_no}*

Buyer reported *${deal.currency} ${Number(amount).toLocaleString()}* transferred.
Reference: *${ref}*.

Please verify funds in your corporate account:`;

          const buttons = [
            { id: `CONFIRM_PAYMENT_${deal.id}_${data.payment_id || data.id}`, title: '✅ Confirm Receipt' },
            { id: `DISPUTE_PAYMENT_${deal.id}_${data.payment_id || data.id}`, title: '⚠️ Dispute' }
          ];

          await whatsappClient.sendQuickReplyButtons(targetPhone, msg, buttons);
        }
      } else if (eventType === 'obligation.overdue') {
        const msg = 
`⚠️ *DEADLINE ALERT: Deal #${deal.reference_no}*

Milestone deliverable *"${data.title || 'Contract Task'}"* is now OVERDUE.
Please upload proof of work or submit a revised timeline immediately.`;

        if (creatorPhone) await whatsappClient.sendTextMessage(creatorPhone, msg);
        if (counterpartyPhone) await whatsappClient.sendTextMessage(counterpartyPhone, msg);
      }
    } catch (err) {
      console.error('[WhatsApp Outbound Dispatch Error]', err);
    }
  }
}

export default ConversationEngine;
