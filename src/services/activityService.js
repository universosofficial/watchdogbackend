import crypto from 'crypto';
import pool from '../config/db.js';
import { AppError } from '../utils/response.js';
import { calculateLogHash, getLatestDealLogHash, verifyAuditChainIntegrity } from '../utils/cryptoChain.js';

/**
 * Immutable Activity & Audit Trail Service with Cryptographic Chaining
 */
export class ActivityService {
  /**
   * Log an immutable audit event for a deal with cryptographic hash chaining
   * @param {string} dealId - Target deal UUID
   * @param {string|null} actorUserId - User UUID performing the action
   * @param {string|null} actorBusinessId - Business UUID performing the action
   * @param {string} eventType - e.g., 'deal.created', 'deal.invitation_sent', 'terms.updated', 'deal.accepted', 'deal.activated', 'deal.completed'
   * @param {object} [details={}] - Contextual details JSON
   * @param {import('mysql2/promise').PoolConnection} [connection=null] - Optional transaction connection
   * @returns {Promise<object>} Created activity log record
   */
  static async logEvent(dealId, actorUserId, actorBusinessId, eventType, details = {}, connection = null) {
    if (!dealId || !eventType) {
      throw new AppError('dealId and eventType are required for audit logging', 400, 'AUDIT_INVALID_PAYLOAD');
    }

    const logId = crypto.randomUUID();
    const detailsJson = JSON.stringify(details || {});
    const executor = connection || pool;
    const now = new Date();
    now.setMilliseconds(0); // Zero out fractional milliseconds to prevent MySQL timestamp rounding drift

    // Cryptographic Chaining: fetch previous hash in chain and compute current hash
    const prevHash = await getLatestDealLogHash(executor, dealId);
    const logHash = calculateLogHash({
      prevHash,
      dealId,
      actorUserId: actorUserId || '',
      actorBusinessId: actorBusinessId || '',
      eventType,
      detailsJson,
      timestamp: now
    });

    await executor.query(
      `INSERT INTO activity_logs (id, deal_id, actor_user_id, actor_business_id, event_type, details_json, prev_hash, log_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [logId, dealId, actorUserId || null, actorBusinessId || null, eventType, detailsJson, prevHash, logHash, now]
    );

    // Asynchronously trigger proactive multi-channel notification (WhatsApp, Telegram, Email)
    setImmediate(async () => {
      try {
        const { default: ConversationEngine } = await import('../integrations/whatsapp/services/conversationEngine.js');
        await ConversationEngine.dispatchOutboundNotification(eventType, { deal_id: dealId, actorUserId, actorBusinessId, ...details });

        const { default: MultiChannelNotifier } = await import('../integrations/multiChannelNotifier.js');
        await MultiChannelNotifier.dispatch(eventType, { deal_id: dealId, actorUserId, actorBusinessId, ...details });
      } catch (err) {
        // Safe failover for outbound alerting
      }
    });

    return {
      id: logId,
      deal_id: dealId,
      actor_user_id: actorUserId,
      actor_business_id: actorBusinessId,
      event_type: eventType,
      details,
      prev_hash: prevHash,
      log_hash: logHash,
      created_at: now.toISOString()
    };
  }

  /**
   * Verify cryptographic audit trail integrity for a deal
   */
  static async verifyAuditChain(dealId) {
    return verifyAuditChainIntegrity(pool, dealId);
  }

  /**
   * Fetch chronological audit timeline for a deal
   * @param {string} dealId
   * @returns {Promise<Array>} Chronological list of events
   */
  static async getDealTimeline(dealId) {
    const [rows] = await pool.query(
      `SELECT 
        al.id,
        al.deal_id,
        al.actor_user_id,
        al.actor_business_id,
        al.event_type,
        al.details_json,
        al.created_at,
        u.full_name AS actor_name,
        u.email AS actor_email,
        b.name AS actor_business_name
      FROM activity_logs al
      LEFT JOIN users u ON al.actor_user_id = u.id
      LEFT JOIN businesses b ON al.actor_business_id = b.id
      WHERE al.deal_id = ?
      ORDER BY al.created_at ASC, al.id ASC`,
      [dealId]
    );

    return rows.map(row => ({
      id: row.id,
      deal_id: row.deal_id,
      actor: {
        user_id: row.actor_user_id,
        user_name: row.actor_name,
        user_email: row.actor_email,
        business_id: row.actor_business_id,
        business_name: row.actor_business_name
      },
      event_type: row.event_type,
      details: typeof row.details_json === 'string' ? JSON.parse(row.details_json) : row.details_json,
      created_at: row.created_at
    }));
  }

  /**
   * Explicitly disallow updating audit logs (Immutable Guarantee)
   */
  static async updateEvent() {
    throw new AppError(
      'Operation Forbidden: Audit logs are strictly immutable and cannot be modified.',
      403,
      'AUDIT_IMMUTABLE'
    );
  }

  /**
   * Explicitly disallow deleting audit logs (Immutable Guarantee)
   */
  static async deleteEvent() {
    throw new AppError(
      'Operation Forbidden: Audit logs are strictly immutable and cannot be deleted.',
      403,
      'AUDIT_IMMUTABLE'
    );
  }
}

export default ActivityService;
