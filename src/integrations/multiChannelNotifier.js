/**
 * Unified Multi-Channel Notification Dispatcher
 * Broadcasts events across WhatsApp, Telegram, and Transactional Email simultaneously
 */
import pool from '../config/db.js';
import whatsappClient from './whatsapp/services/whatsappClient.js';
import telegramClient from './telegram/services/telegramClient.js';
import telegramSession from './telegram/models/telegramSession.js';
import emailClient from './email/services/emailClient.js';
import EmailActionService from './email/services/emailActionService.js';
import { 
  dealInvitationTemplate, 
  paymentReportedTemplate, 
  milestoneProofTemplate, 
  overdueAlertTemplate,
  baseEmailWrapper
} from './email/templates/emailTemplates.js';

export class MultiChannelNotifier {
  /**
   * Main entry point called by ActivityService & WebhookService
   */
  static async dispatch(eventType, data) {
    try {
      const dealId = data.deal_id || data.id;
      if (!dealId) return;

      const [deals] = await pool.query(
        `SELECT d.*, 
                b1.name AS creator_business_name, 
                b2.name AS counterparty_business_name
         FROM deals d
         LEFT JOIN businesses b1 ON d.creator_business_id = b1.id
         LEFT JOIN businesses b2 ON d.counterparty_business_id = b2.id
         WHERE d.id = ?`,
        [dealId]
      );

      if (deals.length === 0) return;
      const deal = deals[0];

      // Fetch users of both businesses
      const [members] = await pool.query(
        `SELECT u.id AS user_id, u.email, u.phone, u.full_name, bm.business_id, bm.role
         FROM users u
         JOIN business_members bm ON u.id = bm.user_id
         WHERE bm.business_id IN (?, ?)`,
        [deal.creator_business_id, deal.counterparty_business_id]
      );

      const creatorUsers = members.filter(m => m.business_id === deal.creator_business_id);
      const counterpartyUsers = members.filter(m => m.business_id === deal.counterparty_business_id);

      const creator = creatorUsers[0] || null;
      const counterparty = counterpartyUsers[0] || null;

      const apiBase = process.env.API_BASE_URL || 'http://localhost:5000';
      const appBase = process.env.APP_BASE_URL || 'http://localhost:4200';
      const workspaceUrl = `${appBase}/deals/${deal.id}`;

      // 1. DEAL CREATION -> Send Invitation to Counterparty
      if (eventType === 'deal.created' && counterparty) {
        // Email with 1-Click Accept Token
        const acceptToken = EmailActionService.generateActionToken('accept_deal', {
          dealId: deal.id,
          businessId: deal.counterparty_business_id,
          userId: counterparty.user_id
        });
        const actionUrl = `${apiBase}/api/v1/integrations/email/actions/accept?token=${acceptToken}`;

        const emailHtml = dealInvitationTemplate({
          deal,
          creatorBiz: { name: deal.creator_business_name },
          recipientName: counterparty.full_name,
          actionUrl,
          workspaceUrl
        });

        await emailClient.sendEmail({
          to: counterparty.email,
          subject: `Contract Invitation: #${deal.reference_no} — ${deal.title}`,
          html: emailHtml,
          actionUrl
        });
      }

      // 2. PAYMENT REPORTED -> Notify Supplier / Payee
      if (eventType === 'payment.reported') {
        const payee = creator; // Or recipient
        if (payee) {
          const confirmToken = EmailActionService.generateActionToken('confirm_payment', {
            dealId: deal.id,
            paymentId: data.payment_id || data.id,
            businessId: deal.creator_business_id,
            userId: payee.user_id
          });
          const confirmUrl = `${apiBase}/api/v1/integrations/email/actions/confirm-payment?token=${confirmToken}`;

          const emailHtml = paymentReportedTemplate({
            deal,
            payment: {
              reported_amount: data.reported_amount || deal.amount,
              currency: deal.currency,
              reference_no: data.reference_no
            },
            confirmUrl,
            workspaceUrl
          });

          await emailClient.sendEmail({
            to: payee.email,
            subject: `Payment Reported: ${deal.currency} ${Number(data.reported_amount || deal.amount).toLocaleString()} for #${deal.reference_no}`,
            html: emailHtml,
            actionUrl: confirmUrl
          });
        }
      }

      // 3. EVIDENCE SUBMITTED -> Notify Partner
      if (eventType === 'evidence.submitted') {
        const isCreatorUploader = data.actorBusinessId === deal.creator_business_id;
        const targetUser = isCreatorUploader ? counterparty : creator;
        const uploaderBiz = isCreatorUploader ? { name: deal.creator_business_name } : { name: deal.counterparty_business_name };

        if (targetUser) {
          const emailHtml = milestoneProofTemplate({
            deal,
            obligation: { title: data.obligation_title || 'Consignment Deliverable' },
            uploaderBiz,
            workspaceUrl
          });

          await emailClient.sendEmail({
            to: targetUser.email,
            subject: `New Proof Uploaded: Deal #${deal.reference_no}`,
            html: emailHtml
          });
        }
      }

      // 4. OBLIGATION OVERDUE -> Notify Both Parties
      if (eventType === 'obligation.overdue') {
        const emailHtml = overdueAlertTemplate({
          deal,
          obligation: { title: data.title || 'Deliverable', due_date: data.due_date },
          workspaceUrl
        });

        if (creator) {
          await emailClient.sendEmail({
            to: creator.email,
            subject: `⚠️ OVERDUE ALERT: #${deal.reference_no}`,
            html: emailHtml
          });
        }
        if (counterparty) {
          await emailClient.sendEmail({
            to: counterparty.email,
            subject: `⚠️ OVERDUE ALERT: #${deal.reference_no}`,
            html: emailHtml
          });
        }
      }

      // 5. DEAL ACTIVATED -> Notify Both Parties
      if (eventType === 'deal.activated') {
        const celebrationHtml = baseEmailWrapper(
          `Contract #${deal.reference_no} is Now ACTIVE!`,
          `<p>Both parties have digitally signed the agreement.</p>
           <p><strong>Deal:</strong> ${deal.title}</p>
           <p><strong>Contract Value:</strong> ${deal.currency} ${Number(deal.amount).toLocaleString()}</p>
           <p>Milestone deliverables are now unlocked under Digital Watchdog trade protection.</p>
           <div style="text-align: center; margin: 1.5rem 0;">
             <a href="${workspaceUrl}" class="btn btn-emerald" style="color: #ffffff;">Open Deal Workspace &rarr;</a>
           </div>`
        );

        if (creator) {
          await emailClient.sendEmail({
            to: creator.email,
            subject: `🎉 Deal #${deal.reference_no} is ACTIVE!`,
            html: celebrationHtml
          });
        }
        if (counterparty) {
          await emailClient.sendEmail({
            to: counterparty.email,
            subject: `🎉 Deal #${deal.reference_no} is ACTIVE!`,
            html: celebrationHtml
          });
        }
      }
    } catch (err) {
      console.error('[Multi-Channel Dispatcher Error]', err);
    }
  }
}

export default MultiChannelNotifier;
