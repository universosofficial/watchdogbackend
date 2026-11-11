/**
 * Email Integration Controller
 * Handles 1-click email action confirmations, inbound webhooks, and mock mailbox testing
 */
import EmailActionService from '../services/emailActionService.js';
import emailClient from '../services/emailClient.js';
import { DealService } from '../../../services/dealService.js';
import { PaymentService } from '../../../services/paymentService.js';
import { sendSuccess, sendError } from '../../../utils/response.js';

export class EmailController {
  /**
   * GET /api/v1/integrations/email/actions/accept
   * 1-Click Agreement Acceptance via Magic Token Link
   */
  static async handleAcceptDeal(req, res) {
    const { token } = req.query;

    try {
      const decoded = EmailActionService.verifyActionToken(token);
      if (decoded.action !== 'accept_deal') {
        return res.status(400).send(EmailController.renderResultPage('Invalid Action', 'This link is not an agreement acceptance token.', false));
      }

      const { dealId, businessId, userId } = decoded.payload;
      const acceptResult = await DealService.acceptDeal({
        dealId,
        businessId,
        userId,
        ipAddress: req.ip || 'Email 1-Click Action'
      });

      const message = acceptResult.deal_status === 'active'
        ? 'Contract is now ACTIVE! Both parties have signed and escrow protections are locked.'
        : 'Your signature has been registered. Waiting for your counterparty to sign.';

      return res.status(200).send(EmailController.renderResultPage(
        'Agreement Signed Successfully!',
        message,
        true,
        `http://localhost:4200/deals/${dealId}`
      ));
    } catch (err) {
      console.error('[Email Accept Deal Error]', err);
      return res.status(400).send(EmailController.renderResultPage('Action Failed', err.message, false));
    }
  }

  /**
   * GET /api/v1/integrations/email/actions/confirm-payment
   * 1-Click Payment Confirmation via Magic Token Link
   */
  static async handleConfirmPayment(req, res) {
    const { token } = req.query;

    try {
      const decoded = EmailActionService.verifyActionToken(token);
      if (decoded.action !== 'confirm_payment') {
        return res.status(400).send(EmailController.renderResultPage('Invalid Action', 'This link is not a payment confirmation token.', false));
      }

      const { dealId, paymentId, businessId, userId } = decoded.payload;
      await PaymentService.updatePaymentStatus({
        dealId,
        paymentId,
        businessId,
        userId,
        status: 'confirmed'
      });

      return res.status(200).send(EmailController.renderResultPage(
        'Payment Receipt Confirmed!',
        'Funds have been certified on the escrow ledger and next project phase is unlocked.',
        true,
        `http://localhost:4200/deals/${dealId}`
      ));
    } catch (err) {
      console.error('[Email Confirm Payment Error]', err);
      return res.status(400).send(EmailController.renderResultPage('Confirmation Failed', err.message, false));
    }
  }

  /**
   * POST /api/v1/integrations/email/webhook
   * Inbound parse webhook (SendGrid / Postmark / Mailgun)
   */
  static async handleInboundWebhook(req, res) {
    res.status(200).json({ status: 'ok' });
  }

  /**
   * GET /api/v1/integrations/email/mock-inbox
   */
  static getMockInbox(req, res) {
    const { to } = req.query;
    const emails = to ? emailClient.getMockEmailsFor(to) : emailClient.getAllMockEmails();
    return sendSuccess(res, { count: emails.length, emails });
  }

  /**
   * POST /api/v1/integrations/email/mock-clear
   */
  static clearMockInbox(req, res) {
    emailClient.clearMockInbox();
    return sendSuccess(res, { cleared: true });
  }

  /**
   * POST /api/v1/integrations/email/mock-send
   * Test endpoint to simulate sending an email
   */
  static async simulateSend(req, res) {
    const { to, subject, html, text, actionType, payload } = req.body;
    let actionUrl = null;

    if (actionType && payload) {
      const token = EmailActionService.generateActionToken(actionType, payload);
      const actionPath = actionType === 'accept_deal' ? 'accept' : 'confirm-payment';
      actionUrl = `http://localhost:5000/api/v1/integrations/email/actions/${actionPath}?token=${token}`;
    }

    const result = await emailClient.sendEmail({
      to: to || 'procurement@betabuilders.ng',
      subject: subject || 'Test Digital Watchdog Notification',
      html: html || `<p>Test email body. Action: <a href="${actionUrl}">${actionUrl}</a></p>`,
      text: text || 'Test email text',
      actionUrl
    });

    return sendSuccess(res, { sent: true, actionUrl, result });
  }

  /**
   * Clean HTML Result Page for Browser Clicks
   */
  static renderResultPage(title, message, isSuccess, workspaceUrl = 'http://localhost:4200') {
    const badgeColor = isSuccess ? '#059669' : '#DC2626';
    const icon = isSuccess ? '✓' : '⚠️';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title} - Digital Watchdog</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #F8FAFC; color: #0F172A; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 1rem; }
    .card { background: #FFFFFF; max-width: 480px; width: 100%; border-radius: 16px; border: 1px solid #E2E8F0; padding: 2.5rem 2rem; text-align: center; box-shadow: 0 10px 25px -5px rgba(15, 23, 42, 0.08); }
    .icon { width: 64px; height: 64px; border-radius: 50%; background: ${isSuccess ? '#ECFDF5' : '#FEF2F2'}; color: ${badgeColor}; font-size: 28px; font-weight: bold; display: flex; align-items: center; justify-content: center; margin: 0 auto 1.25rem; }
    h1 { font-size: 22px; font-weight: 800; margin: 0 0 0.5rem; color: #0F172A; }
    p { font-size: 15px; color: #475569; line-height: 1.5; margin: 0 0 1.75rem; }
    .btn { display: inline-block; background: #2563EB; color: #FFFFFF; font-size: 14px; font-weight: 600; text-decoration: none; padding: 12px 28px; border-radius: 8px; box-shadow: 0 2px 4px rgba(37, 99, 235, 0.2); }
    .btn:hover { background: #1D4ED8; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <a href="${workspaceUrl}" class="btn">Open Deal Workspace &rarr;</a>
  </div>
</body>
</html>`;
  }
}

export default EmailController;
