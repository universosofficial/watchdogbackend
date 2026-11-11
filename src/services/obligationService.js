import crypto from 'crypto';
import pool, { getConnection } from '../config/db.js';
import { AppError } from '../utils/response.js';
import ActivityService from './activityService.js';

export const OBLIGATION_TYPES = ['payment', 'delivery', 'inspection', 'document', 'service'];
export const OBLIGATION_STATUSES = [
  'not_started',
  'in_progress',
  'submitted_for_review',
  'completed',
  'overdue',
  'disputed',
  'cancelled'
];

export class ObligationService {
  /**
   * Create a new obligation on a deal
   */
  static async createObligation({
    dealId,
    creatorBusinessId,
    userId,
    title,
    description,
    responsibleBusinessId,
    type,
    dueDate
  }) {
    if (!title || !title.trim()) {
      throw new AppError('Obligation title is required', 400, 'MISSING_TITLE');
    }

    if (!type || !OBLIGATION_TYPES.includes(type)) {
      throw new AppError(
        `Invalid obligation type. Must be one of: [${OBLIGATION_TYPES.join(', ')}]`,
        400,
        'INVALID_TYPE'
      );
    }

    if (!dueDate || isNaN(new Date(dueDate).getTime())) {
      throw new AppError('Valid due_date timestamp is required', 400, 'INVALID_DUE_DATE');
    }

    // Verify deal and participants
    const [deals] = await pool.query('SELECT * FROM deals WHERE id = ?', [dealId]);
    if (deals.length === 0) {
      throw new AppError('Deal not found', 404, 'DEAL_NOT_FOUND');
    }

    const deal = deals[0];
    const validParties = [deal.creator_business_id, deal.counterparty_business_id].filter(Boolean);

    const targetResponsibleBiz = responsibleBusinessId || deal.counterparty_business_id || deal.creator_business_id;

    if (!validParties.includes(targetResponsibleBiz)) {
      throw new AppError(
        'responsible_business_id must match either the creator or counterparty business',
        400,
        'INVALID_RESPONSIBLE_BUSINESS'
      );
    }

    const obligationId = crypto.randomUUID();
    const formattedDueDate = new Date(dueDate);

    const conn = await getConnection();
    try {
      await conn.beginTransaction();

      await conn.query(
        `INSERT INTO obligations (
          id, deal_id, title, description, responsible_business_id,
          type, due_date, status, completion_date, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'not_started', NULL, NOW(), NOW())`,
        [
          obligationId,
          dealId,
          title.trim(),
          description ? description.trim() : null,
          targetResponsibleBiz,
          type,
          formattedDueDate
        ]
      );

      await ActivityService.logEvent(
        dealId,
        userId,
        creatorBusinessId,
        'obligation.created',
        {
          obligation_id: obligationId,
          title: title.trim(),
          type,
          responsible_business_id: targetResponsibleBiz,
          due_date: formattedDueDate.toISOString()
        },
        conn
      );

      await conn.commit();

      return {
        id: obligationId,
        deal_id: dealId,
        title: title.trim(),
        description: description ? description.trim() : null,
        responsible_business_id: targetResponsibleBiz,
        type,
        due_date: formattedDueDate.toISOString(),
        status: 'not_started',
        completion_date: null,
        is_overdue: formattedDueDate < new Date()
      };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * List all obligations for a deal with computed flags
   */
  static async listObligations(dealId) {
    const [rows] = await pool.query(
      `SELECT 
        o.id,
        o.deal_id,
        o.title,
        o.description,
        o.responsible_business_id,
        o.type,
        o.due_date,
        o.original_due_date,
        o.status,
        o.completion_date,
        o.created_at,
        o.updated_at,
        b.name AS responsible_business_name
      FROM obligations o
      LEFT JOIN businesses b ON o.responsible_business_id = b.id
      WHERE o.deal_id = ?
      ORDER BY o.due_date ASC`,
      [dealId]
    );

    const now = new Date();

    return rows.map(r => ({
      ...r,
      is_overdue: new Date(r.due_date) < now && r.status !== 'completed'
    }));
  }

  /**
   * Update obligation status (e.g. in_progress, completed, disputed)
   */
  static async updateStatus({ dealId, obligationId, businessId, userId, status }) {
    if (!OBLIGATION_STATUSES.includes(status)) {
      throw new AppError(
        `Invalid status '${status}'. Must be one of: [${OBLIGATION_STATUSES.join(', ')}]`,
        400,
        'INVALID_STATUS'
      );
    }

    const [obligations] = await pool.query(
      'SELECT * FROM obligations WHERE id = ? AND deal_id = ?',
      [obligationId, dealId]
    );

    if (obligations.length === 0) {
      throw new AppError('Obligation not found on this deal', 404, 'OBLIGATION_NOT_FOUND');
    }

    const current = obligations[0];
    const isCompleted = status === 'completed';

    const conn = await getConnection();
    try {
      await conn.beginTransaction();

      await conn.query(
        `UPDATE obligations 
         SET status = ?,
             completion_date = CASE WHEN ? = 1 THEN NOW() ELSE NULL END,
             updated_at = NOW()
         WHERE id = ?`,
        [status, isCompleted ? 1 : 0, obligationId]
      );

      const eventType = isCompleted ? 'obligation.completed' : 'obligation.status_updated';

      await ActivityService.logEvent(
        dealId,
        userId,
        businessId,
        eventType,
        {
          obligation_id: obligationId,
          previous_status: current.status,
          new_status: status,
          completion_date: isCompleted ? new Date().toISOString() : null
        },
        conn
      );

      await conn.commit();

      const [updated] = await pool.query('SELECT * FROM obligations WHERE id = ?', [obligationId]);
      const now = new Date();

      return {
        ...updated[0],
        is_overdue: new Date(updated[0].due_date) < now && updated[0].status !== 'completed'
      };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * Approves deadline extension without erasing original deadline
   */
  static async extendDeadline({ dealId, obligationId, businessId, userId, newDueDate, reason }) {
    if (!newDueDate || isNaN(new Date(newDueDate).getTime())) {
      throw new AppError('Valid new_due_date timestamp is required', 400, 'INVALID_DUE_DATE');
    }

    const formattedNewDate = new Date(newDueDate);

    const [obligations] = await pool.query(
      'SELECT * FROM obligations WHERE id = ? AND deal_id = ?',
      [obligationId, dealId]
    );

    if (obligations.length === 0) {
      throw new AppError('Obligation not found on this deal', 404, 'OBLIGATION_NOT_FOUND');
    }

    const obligation = obligations[0];
    const originalDueDate = obligation.original_due_date || obligation.due_date;

    const conn = await getConnection();
    try {
      await conn.beginTransaction();

      await conn.query(
        `UPDATE obligations
         SET original_due_date = COALESCE(original_due_date, due_date),
             due_date = ?,
             updated_at = NOW()
         WHERE id = ?`,
        [formattedNewDate, obligationId]
      );

      await ActivityService.logEvent(
        dealId,
        userId,
        businessId,
        'obligation.deadline_extended',
        {
          obligation_id: obligationId,
          original_due_date: new Date(originalDueDate).toISOString(),
          previous_due_date: new Date(obligation.due_date).toISOString(),
          new_due_date: formattedNewDate.toISOString(),
          reason: reason || 'Mutual extension approval'
        },
        conn
      );

      await conn.commit();

      const [updated] = await pool.query('SELECT * FROM obligations WHERE id = ?', [obligationId]);
      const now = new Date();

      return {
        ...updated[0],
        is_overdue: new Date(updated[0].due_date) < now && updated[0].status !== 'completed'
      };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }
}

export default ObligationService;
