import crypto from 'crypto';
import pool from '../config/db.js';
import { AppError } from '../utils/response.js';
import ActivityService from './activityService.js';

/**
 * World Wide Security (WWS) Integration Service
 * Manages authenticated server-to-server escalation dispatch and status synchronization.
 * Enforces Section 4 Business Rule: Only authorized DW admins can initiate escalation.
 */
export class WwsEscalationService {
  /**
   * Initiate an authenticated escalation from Digital Watchdog to WWS
   */
  static async initiateEscalation({
    dealId,
    disputeId,
    businessId,
    userId,
    userRole,
    userEmail,
    userName,
    escalationReason,
    incidentCategory,
    approvedFields = [],
    authorityConfirmed = false
  }) {
    // 1. Role Authorization Check (Section 4, Step 3)
    if (userRole !== 'owner' && userRole !== 'admin') {
      throw new AppError(
        'Access Denied: Only authorized Digital Watchdog administrators can initiate an escalation to World Wide Security.',
        403,
        'FORBIDDEN_ESCALATION'
      );
    }

    // 2. Explicit Authority Confirmation Check
    if (!authorityConfirmed) {
      throw new AppError(
        'Explicit authority confirmation is required. Admin must verify statutory authorization to transfer incident records.',
        400,
        'AUTHORITY_CONFIRMATION_REQUIRED'
      );
    }

    if (!escalationReason || escalationReason.trim().length < 10) {
      throw new AppError(
        'A comprehensive escalation reason (at least 10 characters) is required for institutional referral review.',
        400,
        'INVALID_ESCALATION_REASON'
      );
    }

    // 3. Retrieve Deal & Dispute
    const [dealRows] = await pool.query('SELECT * FROM deals WHERE id = ?', [dealId]);
    if (dealRows.length === 0) {
      throw new AppError('Deal record not found', 404, 'DEAL_NOT_FOUND');
    }
    const deal = dealRows[0];

    let dispute = null;
    if (disputeId) {
      const [disputeRows] = await pool.query('SELECT * FROM disputes WHERE id = ? AND deal_id = ?', [disputeId, dealId]);
      if (disputeRows.length === 0) {
        throw new AppError('Dispute record not found for this deal', 404, 'DISPUTE_NOT_FOUND');
      }
      dispute = disputeRows[0];
    } else {
      const [disputeRows] = await pool.query(
        'SELECT * FROM disputes WHERE deal_id = ? ORDER BY created_at DESC LIMIT 1',
        [dealId]
      );
      if (disputeRows.length > 0) {
        dispute = disputeRows[0];
      }
    }

    // 4. Check for existing escalation receipt
    if (dispute && dispute.wws_case_reference) {
      return {
        success: true,
        is_duplicate: true,
        case_reference: dispute.wws_case_reference,
        receipt: typeof dispute.wws_receipt_json === 'string' ? JSON.parse(dispute.wws_receipt_json) : dispute.wws_receipt_json,
        message: `Issue is already linked to World Wide Security case ${dispute.wws_case_reference}.`
      };
    }

    // 5. Query Evidence (Sanitize to avoid credentials/private keys)
    const [evidenceRows] = await pool.query(
      `SELECT id, file_name, file_size, mime_type, notes, created_at 
       FROM evidence_records 
       WHERE deal_id = ?`,
      [dealId]
    );

    const sanitizedEvidence = evidenceRows.map(ev => ({
      evidence_id: ev.id,
      file_name: ev.file_name,
      file_size: ev.file_size,
      mime_type: ev.mime_type,
      description: ev.notes || 'Uploaded transaction milestone evidence document'
    }));

    // 6. Build Conceptual Event Payload (Section 4, Step 4)
    const eventId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const escalatedAt = new Date().toISOString();

    const approvedSharedFieldsList = approvedFields && approvedFields.length > 0 
      ? approvedFields 
      : ['deal_reference', 'dispute_reference', 'dispute_category', 'total_amount', 'currency', 'obligations_summary'];

    const eventPayload = {
      event_id: eventId,
      source_system: 'digital_watchdog',
      source_issue_id: dispute ? (dispute.reference_no || dispute.id) : `DW-ISSUE-${deal.reference_no || deal.id}`,
      source_transaction_id: deal.reference_no || deal.id,
      escalated_by: userEmail || userName || `admin-${userId.substring(0, 8)}`,
      escalated_at: escalatedAt,
      escalation_reason: escalationReason.trim(),
      incident_category: incidentCategory || (dispute ? dispute.category : 'escrow_diversion'),
      incident_summary: dispute && dispute.description ? dispute.description.substring(0, 255) : `Dispute escalated on milestone deal ${deal.reference_no || deal.id}`,
      incident_details: dispute && dispute.description ? dispute.description : `Breach of contract covenants without rectification. Total transaction volume: ${deal.total_amount || 0} ${deal.currency || 'NGN'}.`,
      evidence_references: sanitizedEvidence,
      approved_shared_fields: approvedSharedFieldsList,
      source_status: dispute ? (dispute.status || 'open') : (deal.cure_status || deal.status),
      consent_or_authority_reference: `DW-AUTH-AFFIDAVIT-${userId.substring(0, 8)}-${Date.now()}`,
      correlation_id: correlationId,
      schema_version: '1.0.0'
    };

    // 7. HMAC-SHA256 Signatures & Mutual Authentication
    const secret = process.env.DIGITAL_WATCHDOG_HMAC_SECRET || 'dw_wws_shared_hmac_secret_2026_prod_token_sig';
    const rawPayload = JSON.stringify(eventPayload);
    const stringToSign = `${timestamp}.${rawPayload}`;
    const hmacSignature = crypto.createHmac('sha256', secret).update(stringToSign).digest('hex');

    const wwsBaseUrl = process.env.WWS_API_BASE_URL || 'http://localhost:5100/api/v1';
    const targetUrl = `${wwsBaseUrl}/integration/digital-watchdog/escalations`;

    let responseData;
    try {
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-WWS-Client-Id': 'dw_integration_agent_01',
          'X-WWS-Signature': hmacSignature,
          'X-WWS-Timestamp': timestamp,
          'X-WWS-Correlation-Id': correlationId,
          'X-WWS-Source-System': 'digital_watchdog'
        },
        body: rawPayload
      });

      const responseJson = await response.json();

      if (!response.ok || !responseJson.success) {
        const errorMsg = responseJson.message || `WWS server responded with HTTP ${response.status}`;
        throw new AppError(`Escalation failed at World Wide Security: ${errorMsg}`, response.status || 502, 'WWS_DISPATCH_FAILED');
      }

      responseData = responseJson.data;
    } catch (networkErr) {
      if (networkErr instanceof AppError) throw networkErr;
      throw new AppError(
        `Failed to reach World Wide Security integration gateway at ${targetUrl}: ${networkErr.message}`,
        502,
        'WWS_NETWORK_ERROR'
      );
    }

    const wwsCaseRef = responseData.case_reference || responseData.wws_case_reference;
    const receiptJson = JSON.stringify(responseData);
    const sqlEscalatedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');

    // 8. Update Dispute and Deal with Escalation Receipt
    if (dispute) {
      await pool.query(
        `UPDATE disputes 
         SET wws_case_reference = ?, wws_escalated_at = ?, wws_escalated_by = ?, wws_receipt_json = ? 
         WHERE id = ?`,
        [wwsCaseRef, sqlEscalatedAt, userEmail || userId, receiptJson, dispute.id]
      );
    }

    await pool.query(
      `UPDATE deals 
       SET wws_case_reference = ?, wws_escalated_at = ?, wws_receipt_json = ? 
       WHERE id = ?`,
      [wwsCaseRef, sqlEscalatedAt, receiptJson, dealId]
    );

    // 9. Record Immutable Audit Activity
    await ActivityService.logEvent(
      dealId,
      userId,
      businessId,
      'WWS_SECURITY_ESCALATION_INITIATED',
      {
        wws_case_reference: wwsCaseRef,
        dispute_id: dispute ? dispute.id : null,
        escalation_reason: escalationReason,
        incident_category: eventPayload.incident_category,
        receipt: responseData,
        escalated_at: escalatedAt
      }
    );

    return {
      success: true,
      case_reference: wwsCaseRef,
      status: responseData.status || (responseData.receipt_status === 'duplicate_accepted' ? 'duplicate_accepted' : 'awaiting_review'),
      receipt: responseData,
      message: `Escalation received and logged by World Wide Security under case reference ${wwsCaseRef}.`
    };
  }

  /**
   * Handle incoming status update callback from WWS
   */
  static async handleStatusCallback({ headers, body }) {
    const signature = headers['x-wws-signature'];
    const timestamp = headers['x-wws-timestamp'];
    const sourceSystem = headers['x-wws-source-system'];

    if (!signature || !timestamp || sourceSystem !== 'world_wide_security') {
      throw new AppError('Missing or invalid WWS callback authentication headers', 401, 'INVALID_WWS_HEADERS');
    }

    // Verify clock skew (5 minutes)
    const now = Date.now();
    const reqTime = parseInt(timestamp, 10);
    if (isNaN(reqTime) || Math.abs(now - reqTime) > 300000) {
      throw new AppError('Callback timestamp out of allowable clock skew window (5m)', 401, 'CLOCK_SKEW_EXCEEDED');
    }

    // Verify HMAC
    const secret = process.env.DIGITAL_WATCHDOG_HMAC_SECRET || 'dw_wws_shared_hmac_secret_2026_prod_token_sig';
    const rawPayload = typeof body === 'string' ? body : JSON.stringify(body);
    const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawPayload}`).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) {
      throw new AppError('Invalid WWS callback signature', 401, 'INVALID_SIGNATURE');
    }

    const { case_reference, new_status, source_issue_id, notes, updated_at } = body;

    // Find linked deal or dispute
    const [disputes] = await pool.query('SELECT * FROM disputes WHERE wws_case_reference = ? OR id = ?', [case_reference, source_issue_id]);
    if (disputes.length > 0) {
      const d = disputes[0];
      await ActivityService.logEvent(
        d.deal_id,
        null,
        null,
        'WWS_STATUS_UPDATE_RECEIVED',
        {
          case_reference,
          new_status,
          notes,
          updated_at
        }
      );
    }

    return {
      received: true,
      case_reference,
      acknowledged_at: new Date().toISOString()
    };
  }
}

export default WwsEscalationService;
