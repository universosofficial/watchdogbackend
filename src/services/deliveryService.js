import crypto from 'crypto';
import pool, { getConnection } from '../config/db.js';
import { AppError } from '../utils/response.js';
import ActivityService from './activityService.js';

export const DELIVERY_STATUSES = [
  'dispatched',
  'delivered',
  'acknowledged_with_discrepancy',
  'confirmed'
];

export class DeliveryService {
  /**
   * Record delivery dispatch
   */
  static async recordDelivery({
    dealId,
    businessId,
    userId,
    items,
    dispatchDate = null,
    deliveryReference,
    obligationId = null,
    evidenceId = null,
    notes = null
  }) {
    if (!deliveryReference || !deliveryReference.trim()) {
      throw new AppError('delivery_reference (e.g. waybill / tracking number) is required', 400, 'MISSING_DELIVERY_REFERENCE');
    }

    const [deals] = await pool.query('SELECT * FROM deals WHERE id = ?', [dealId]);
    if (deals.length === 0) {
      throw new AppError('Deal not found', 404, 'DEAL_NOT_FOUND');
    }

    const deliveryId = crypto.randomUUID();
    const formattedDispatchDate = dispatchDate ? new Date(dispatchDate) : new Date();
    const itemsJsonString = typeof items === 'string' ? items : JSON.stringify(items || []);

    const conn = await getConnection();
    try {
      await conn.beginTransaction();

      await conn.query(
        `INSERT INTO delivery_records (
          id, deal_id, obligation_id, items_json, dispatch_date,
          receipt_date, delivery_reference, evidence_id, status, notes, created_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'dispatched', ?, NOW())`,
        [
          deliveryId,
          dealId,
          obligationId || null,
          itemsJsonString,
          formattedDispatchDate,
          deliveryReference.trim(),
          evidenceId || null,
          notes ? notes.trim() : null
        ]
      );

      await ActivityService.logEvent(
        dealId,
        userId,
        businessId,
        'delivery.dispatched',
        {
          delivery_id: deliveryId,
          delivery_reference: deliveryReference.trim(),
          dispatch_date: formattedDispatchDate.toISOString(),
          obligation_id: obligationId || null
        },
        conn
      );

      await conn.commit();

      return {
        id: deliveryId,
        deal_id: dealId,
        obligation_id: obligationId || null,
        items_json: typeof items === 'string' ? JSON.parse(items) : (items || []),
        dispatch_date: formattedDispatchDate.toISOString(),
        receipt_date: null,
        delivery_reference: deliveryReference.trim(),
        status: 'dispatched',
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
   * Recipient acknowledges receipt or discrepancy
   */
  static async updateDeliveryStatus({ dealId, deliveryId, businessId, userId, status, notes }) {
    if (!DELIVERY_STATUSES.includes(status) || status === 'dispatched') {
      throw new AppError(
        "Invalid receipt status. Allowed: 'delivered', 'acknowledged_with_discrepancy', 'confirmed'",
        400,
        'INVALID_STATUS'
      );
    }

    const [deliveries] = await pool.query(
      'SELECT * FROM delivery_records WHERE id = ? AND deal_id = ?',
      [deliveryId, dealId]
    );

    if (deliveries.length === 0) {
      throw new AppError('Delivery record not found on this deal', 404, 'DELIVERY_NOT_FOUND');
    }

    const delivery = deliveries[0];

    const conn = await getConnection();
    try {
      await conn.beginTransaction();

      await conn.query(
        `UPDATE delivery_records
         SET status = ?,
             receipt_date = COALESCE(receipt_date, NOW()),
             notes = COALESCE(?, notes)
         WHERE id = ?`,
        [status, notes ? notes.trim() : null, deliveryId]
      );

      let eventType = 'delivery.status_updated';
      if (status === 'confirmed') eventType = 'delivery.confirmed';
      if (status === 'acknowledged_with_discrepancy') eventType = 'delivery.discrepancy_reported';

      await ActivityService.logEvent(
        dealId,
        userId,
        businessId,
        eventType,
        {
          delivery_id: deliveryId,
          previous_status: delivery.status,
          new_status: status,
          delivery_reference: delivery.delivery_reference,
          notes: notes ? notes.trim() : null
        },
        conn
      );

      await conn.commit();

      const [updated] = await pool.query('SELECT * FROM delivery_records WHERE id = ?', [deliveryId]);
      return {
        ...updated[0],
        items_json: typeof updated[0].items_json === 'string'
          ? JSON.parse(updated[0].items_json)
          : updated[0].items_json
      };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * List delivery history for deal
   */
  static async listDeliveries(dealId) {
    const [rows] = await pool.query(
      `SELECT 
        dr.id,
        dr.deal_id,
        dr.obligation_id,
        dr.items_json,
        dr.dispatch_date,
        dr.receipt_date,
        dr.delivery_reference,
        dr.status,
        dr.notes,
        dr.created_at,
        o.title AS obligation_title
      FROM delivery_records dr
      LEFT JOIN obligations o ON dr.obligation_id = o.id
      WHERE dr.deal_id = ?
      ORDER BY dr.created_at DESC`,
      [dealId]
    );

    return rows.map(r => ({
      ...r,
      items_json: typeof r.items_json === 'string' ? JSON.parse(r.items_json) : r.items_json
    }));
  }
}

export default DeliveryService;
