import crypto from 'crypto';
import pool, { getConnection } from '../config/db.js';
import { AppError } from '../utils/response.js';
import ActivityService from './activityService.js';
import TrustRadarService from './trustRadarService.js';

export const PAYMENT_STATUSES = ['reported', 'acknowledged', 'confirmed', 'disputed'];

export class PaymentService {
  /**
   * Record an off-platform payment attestation entry in the deal ledger
   */
  static async recordPayment({
    dealId,
    businessId,
    userId,
    expectedAmount,
    reportedAmount,
    currency = 'NGN',
    referenceNo,
    externalReference = null,
    paymentMethod = 'bank_transfer',
    sendingInstitution = null,
    recipientInstitution = null,
    paidAt = null,
    transferTimestamp = null,
    obligationId = null,
    evidenceId = null,
    destinationAccountNumber = null,
    destinationBankName = null,
    destinationAccountName = null,
    beneficiaryMatchConfirmed = false,
    notes = null,
    payerBusinessId = null,
    recipientBusinessId = null
  }) {
    if (reportedAmount === undefined || isNaN(reportedAmount) || Number(reportedAmount) <= 0) {
      throw new AppError('Valid positive reported_amount is required', 400, 'INVALID_AMOUNT');
    }

    const [deals] = await pool.query('SELECT * FROM deals WHERE id = ?', [dealId]);
    if (deals.length === 0) {
      throw new AppError('Deal not found', 404, 'DEAL_NOT_FOUND');
    }

    const deal = deals[0];

    // Determine payer and recipient businesses
    let payer = payerBusinessId;
    let recipient = recipientBusinessId;

    if (!payer || !recipient) {
      if (businessId === deal.counterparty_business_id) {
        payer = deal.counterparty_business_id;
        recipient = deal.creator_business_id;
      } else {
        payer = deal.creator_business_id;
        recipient = deal.counterparty_business_id || deal.creator_business_id;
      }
    }

    // Fetch recipient business banking anchor
    const [recipientBizRows] = await pool.query(
      'SELECT id, name, bank_name, bank_code, verified_account_number, verified_account_name, is_bank_verified FROM businesses WHERE id = ?',
      [recipient]
    );
    const recipientBiz = recipientBizRows[0];

    // NUBAN SETTLEMENT ENFORCEMENT:
    // If recipient has an anchored bank account, enforce destination check
    if (recipientBiz?.is_bank_verified && recipientBiz.verified_account_number) {
      const cleanAnchor = String(recipientBiz.verified_account_number).trim();
      if (destinationAccountNumber) {
        const cleanDest = String(destinationAccountNumber).trim();
        if (cleanDest !== cleanAnchor) {
          throw new AppError(
            `Unauthorized destination account number: "${cleanDest}". For your protection, funds must be transferred ONLY to the seller's verified beneficiary account (${recipientBiz.bank_name} - ${cleanAnchor}). Paying unauthorized accounts is strictly prohibited.`,
            400,
            'UNAUTHORIZED_DESTINATION_ACCOUNT'
          );
        }
      }
    }

    const finalDestBank = destinationBankName || recipientBiz?.bank_name || null;
    const finalDestAccount = destinationAccountNumber || recipientBiz?.verified_account_number || null;
    const finalDestName = destinationAccountName || recipientBiz?.verified_account_name || null;
    const isBeneficiaryConfirmed = Boolean(beneficiaryMatchConfirmed || (destinationAccountNumber && recipientBiz?.is_bank_verified));

    const paymentId = crypto.randomUUID();
    const expAmount = expectedAmount !== undefined ? Number(expectedAmount) : Number(reportedAmount);
    const repAmount = Number(reportedAmount);
    const effectivePaidAt = paidAt ? new Date(paidAt) : (transferTimestamp ? new Date(transferTimestamp) : new Date());
    const finalExtRef = externalReference || referenceNo || `WIRE-${Date.now()}`;

    const conn = await getConnection();
    try {
      await conn.beginTransaction();

      await conn.query(
        `INSERT INTO payment_records (
          id, deal_id, obligation_id, expected_amount, reported_amount,
          currency, payment_method, sending_institution, recipient_institution,
          destination_bank_name, destination_account_number, destination_account_name,
          beneficiary_match_confirmed, payer_business_id, recipient_business_id,
          reference_no, evidence_id, external_reference,
          status, paid_at, transfer_timestamp, reported_by_user_id, notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reported', ?, ?, ?, ?, NOW())`,
        [
          paymentId,
          dealId,
          obligationId || null,
          expAmount.toFixed(2),
          repAmount.toFixed(2),
          (currency || deal.currency).toUpperCase(),
          paymentMethod || 'bank_transfer',
          sendingInstitution || null,
          recipientInstitution || null,
          finalDestBank,
          finalDestAccount,
          finalDestName,
          isBeneficiaryConfirmed,
          payer,
          recipient,
          referenceNo ? referenceNo.trim() : finalExtRef,
          evidenceId || null,
          finalExtRef,
          effectivePaidAt,
          effectivePaidAt,
          userId,
          notes ? notes.trim() : null
        ]
      );

      await ActivityService.logEvent(
        dealId,
        userId,
        businessId,
        'payment.reported',
        {
          payment_id: paymentId,
          reported_amount: repAmount,
          currency: (currency || deal.currency).toUpperCase(),
          external_reference: finalExtRef,
          sending_institution: sendingInstitution,
          recipient_institution: recipientInstitution,
          payer_business_id: payer,
          recipient_business_id: recipient,
          obligation_id: obligationId || null
        },
        conn
      );

      await conn.commit();

      return {
        id: paymentId,
        deal_id: dealId,
        obligation_id: obligationId || null,
        expected_amount: expAmount,
        reported_amount: repAmount,
        currency: (currency || deal.currency).toUpperCase(),
        payment_method: paymentMethod || 'bank_transfer',
        sending_institution: sendingInstitution,
        recipient_institution: recipientInstitution,
        payer_business_id: payer,
        recipient_business_id: recipient,
        destination_bank_name: finalDestBank,
        destination_account_number: finalDestAccount,
        destination_account_name: finalDestName,
        beneficiary_match_confirmed: isBeneficiaryConfirmed,
        reference_no: referenceNo || finalExtRef,
        external_reference: finalExtRef,
        status: 'reported',
        paid_at: effectivePaidAt.toISOString(),
        transfer_timestamp: effectivePaidAt.toISOString(),
        reported_by_user_id: userId,
        notes: notes ? notes.trim() : null,
        created_at: new Date().toISOString()
      };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * Update payment status (Seller verifies bank ledger & confirms with legal attestation)
   */
  static async updatePaymentStatus({ dealId, paymentId, businessId, userId, status, attestationStatement = null }) {
    if (!['acknowledged', 'confirmed', 'disputed'].includes(status)) {
      throw new AppError(
        "Invalid payment transition status. Allowed: 'acknowledged', 'confirmed', or 'disputed'",
        400,
        'INVALID_STATUS'
      );
    }

    const [payments] = await pool.query(
      'SELECT * FROM payment_records WHERE id = ? AND deal_id = ?',
      [paymentId, dealId]
    );

    if (payments.length === 0) {
      throw new AppError('Payment record not found on this deal', 404, 'PAYMENT_NOT_FOUND');
    }

    const payment = payments[0];

    // Verification: Recipient business (Seller) must be the one confirming payment
    if (payment.recipient_business_id && payment.recipient_business_id !== businessId) {
      throw new AppError(
        'Access denied: Only the recipient seller business can confirm or dispute received payments',
        403,
        'FORBIDDEN_PAYMENT_CONFIRMATION'
      );
    }

    const isConfirmed = status === 'confirmed';
    let legalStatement = attestationStatement;

    if (isConfirmed && !legalStatement) {
      const [bizRows] = await pool.query('SELECT name FROM businesses WHERE id = ?', [businessId]);
      const sellerName = bizRows[0]?.name || 'Supplier / Contractor';
      legalStatement = `I certify on behalf of ${sellerName} that ${payment.reported_amount} ${payment.currency} has irrevocably cleared into our designated bank account.`;
    }

    const conn = await getConnection();
    try {
      await conn.beginTransaction();

      // Row lock the payment record to prevent duplicate concurrent confirmations
      const [lockedPayment] = await conn.query('SELECT * FROM payment_records WHERE id = ? FOR UPDATE', [paymentId]);
      if (lockedPayment.length === 0) {
        throw new AppError('Payment record not found', 404, 'PAYMENT_NOT_FOUND');
      }

      await conn.query(
        `UPDATE payment_records
         SET status = ?,
             paid_at = COALESCE(paid_at, NOW()),
             confirmed_by_user_id = ?,
             confirmed_at = ${isConfirmed ? 'NOW()' : 'NULL'},
             attestation_statement = ?
         WHERE id = ?`,
        [status, isConfirmed ? userId : null, isConfirmed ? legalStatement : null, paymentId]
      );

      const eventType = isConfirmed ? 'payment.confirmed' : (status === 'disputed' ? 'payment.disputed' : 'payment.acknowledged');
      await ActivityService.logEvent(
        dealId,
        userId,
        businessId,
        eventType,
        {
          payment_id: paymentId,
          previous_status: payment.status,
          new_status: status,
          amount: Number(payment.reported_amount),
          currency: payment.currency,
          external_reference: payment.external_reference || payment.reference_no,
          attestation_statement: legalStatement
        },
        conn
      );

      await conn.commit();

      // Re-evaluate trust score for both businesses
      if (isConfirmed) {
        await TrustRadarService.evaluateBusinessTrust(businessId);
        if (payment.payer_business_id) {
          await TrustRadarService.evaluateBusinessTrust(payment.payer_business_id);
        }
      }

      const [updated] = await pool.query('SELECT * FROM payment_records WHERE id = ?', [paymentId]);
      return updated[0];
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * Return financial overview summary and payment records
   */
  static async getPaymentSummary(dealId) {
    const [deals] = await pool.query('SELECT * FROM deals WHERE id = ?', [dealId]);
    if (deals.length === 0) {
      throw new AppError('Deal not found', 404, 'DEAL_NOT_FOUND');
    }

    const deal = deals[0];
    const dealAmount = Number(deal.amount);

    const [payments] = await pool.query(
      `SELECT pr.*, 
        pb.name as payer_business_name, 
        rb.name as recipient_business_name,
        ru.full_name as reported_by_user_name,
        cu.full_name as confirmed_by_user_name
       FROM payment_records pr
       LEFT JOIN businesses pb ON pr.payer_business_id = pb.id
       LEFT JOIN businesses rb ON pr.recipient_business_id = rb.id
       LEFT JOIN users ru ON pr.reported_by_user_id = ru.id
       LEFT JOIN users cu ON pr.confirmed_by_user_id = cu.id
       WHERE pr.deal_id = ?
       ORDER BY pr.created_at DESC`,
      [dealId]
    );

    let totalReported = 0;
    let totalConfirmed = 0;
    let pendingConfirmationCount = 0;

    for (const p of payments) {
      const amt = Number(p.reported_amount);
      if (p.status === 'confirmed') {
        totalConfirmed += amt;
      } else if (p.status === 'reported') {
        totalReported += amt;
        pendingConfirmationCount++;
      }
    }

    const remainingToReport = Math.max(0, dealAmount - (totalConfirmed + totalReported));
    const unreconciledBalance = Math.max(0, dealAmount - totalConfirmed);

    return {
      deal_id: dealId,
      deal_amount: dealAmount,
      total_agreed_amount: dealAmount,
      currency: deal.currency,
      total_confirmed: totalConfirmed,
      total_reported_pending: totalReported,
      remaining_unfunded: remainingToReport,
      unreconciled_balance: unreconciledBalance,
      outstanding_balance: unreconciledBalance,
      is_fully_reconciled: unreconciledBalance === 0,
      pending_confirmation_count: pendingConfirmationCount,
      payments
    };
  }
}

export default PaymentService;
