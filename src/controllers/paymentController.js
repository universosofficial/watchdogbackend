import PaymentService from '../services/paymentService.js';
import { sendSuccess } from '../utils/response.js';

export async function recordPayment(req, res, next) {
  try {
    const { dealId } = req.params;
    const {
      expected_amount,
      reported_amount,
      amount,
      currency,
      reference_no,
      evidence_id,
      evidenceId,
      paid_at,
      payment_method,
      paymentMethod,
      external_reference,
      externalReference,
      transfer_timestamp,
      transferTimestamp,
      destination_bank_name,
      destinationBankName,
      destination_account_number,
      destinationAccountNumber,
      destination_account_name,
      destinationAccountName,
      beneficiary_match_confirmed,
      beneficiaryMatchConfirmed,
      obligation_id,
      notes,
      payer_business_id,
      recipient_business_id
    } = req.body;

    const result = await PaymentService.recordPayment({
      dealId,
      businessId: req.businessId,
      userId: req.userId,
      expectedAmount: expected_amount,
      reportedAmount: reported_amount !== undefined ? reported_amount : amount,
      currency,
      referenceNo: reference_no,
      externalReference: external_reference || externalReference || null,
      paymentMethod: payment_method || paymentMethod || 'bank_transfer',
      transferTimestamp: transfer_timestamp || transferTimestamp || null,
      destinationBankName: destination_bank_name || destinationBankName || null,
      destinationAccountNumber: destination_account_number || destinationAccountNumber || null,
      destinationAccountName: destination_account_name || destinationAccountName || null,
      beneficiaryMatchConfirmed: Boolean(beneficiary_match_confirmed || beneficiaryMatchConfirmed),
      evidenceId: evidence_id || evidenceId || null,
      paidAt: paid_at,
      obligationId: obligation_id,
      notes,
      payerBusinessId: payer_business_id,
      recipientBusinessId: recipient_business_id
    });

    return sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

export async function updatePaymentStatus(req, res, next) {
  try {
    const { dealId, paymentId } = req.params;
    const { status } = req.body;

    const result = await PaymentService.updatePaymentStatus({
      dealId,
      paymentId,
      businessId: req.businessId,
      userId: req.userId,
      status
    });

    return sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

export async function getPaymentSummary(req, res, next) {
  try {
    const { dealId } = req.params;
    const summary = await PaymentService.getPaymentSummary(dealId);
    return sendSuccess(res, { financial_summary: summary, ...summary });
  } catch (error) {
    next(error);
  }
}
