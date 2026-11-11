import crypto from 'crypto';
import pool, { getConnection } from '../config/db.js';
import { AppError } from '../utils/response.js';

export const SUPPORTED_WEBHOOK_EVENTS = [
  'deal.created',
  'deal.accepted',
  'deal.activated',
  'deal.completed',
  'obligation.created',
  'obligation.overdue',
  'obligation.completed',
  'evidence.submitted',
  'payment.reported',
  'payment.confirmed',
  'delivery.dispatched',
  'delivery.confirmed',
  'dispute.opened',
  'dispute.resolved'
];

/**
 * SSRF Protection Validator
 * Blocks loopback, link-local, and RFC1918 private IP blocks
 */
export function isSsrfSafeUrl(urlStr) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch (err) {
    return { safe: false, reason: 'Malformed URL' };
  }

  // Enforce http/https protocols
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { safe: false, reason: `Unsupported protocol '${parsed.protocol}'. Must be http or https.` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost and IPv6 loopback
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') {
    return { safe: false, reason: 'Loopback hostname is forbidden by SSRF protection policy.' };
  }

  // Check IPv4 addresses
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1, 5).map(Number);
    for (const oct of octets) {
      if (oct < 0 || oct > 255) {
        return { safe: false, reason: 'Invalid IP address format' };
      }
    }

    const [o1, o2] = octets;

    // 127.0.0.0/8 (Loopback)
    if (o1 === 127) {
      return { safe: false, reason: '127.0.0.0/8 loopback is forbidden by SSRF protection policy.' };
    }

    // 0.0.0.0/8 (Current network)
    if (o1 === 0) {
      return { safe: false, reason: '0.0.0.0/8 is forbidden by SSRF protection policy.' };
    }

    // 10.0.0.0/8 (Private class A)
    if (o1 === 10) {
      return { safe: false, reason: '10.0.0.0/8 private network is forbidden by SSRF protection policy.' };
    }

    // 172.16.0.0/12 (Private class B: 172.16 - 172.31)
    if (o1 === 172 && o2 >= 16 && o2 <= 31) {
      return { safe: false, reason: '172.16.0.0/12 private network is forbidden by SSRF protection policy.' };
    }

    // 192.168.0.0/16 (Private class C)
    if (o1 === 192 && o2 === 168) {
      return { safe: false, reason: '192.168.0.0/16 private network is forbidden by SSRF protection policy.' };
    }

    // 169.254.0.0/16 (Link-local & Cloud Metadata)
    if (o1 === 169 && o2 === 254) {
      return { safe: false, reason: '169.254.0.0/16 link-local metadata address is strictly blocked.' };
    }
  }

  return { safe: true };
}

/**
 * Webhook Dispatcher and Signing Engine
 */
export class WebhookService {
  /**
   * Generates a secure shared secret for an endpoint
   */
  static generateSecret() {
    return `whsec_${crypto.randomBytes(24).toString('hex')}`;
  }

  /**
   * Compute HMAC-SHA256 signature header for payload string
   * @param {string} payloadString
   * @param {string} secretKey
   * @returns {string} e.g. "sha256=<hex>"
   */
  static computeSignature(payloadString, secretKey) {
    const hmac = crypto.createHmac('sha256', secretKey).update(payloadString).digest('hex');
    return `sha256=${hmac}`;
  }

  /**
   * Verify HMAC-SHA256 signature using timingSafeEqual
   * @param {string} payloadString
   * @param {string} signatureHeader
   * @param {string} secretKey
   * @returns {boolean}
   */
  static verifySignature(payloadString, signatureHeader, secretKey) {
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
      return false;
    }

    const expectedHmac = crypto.createHmac('sha256', secretKey).update(payloadString).digest('hex');
    const expectedSignature = `sha256=${expectedHmac}`;

    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
    const actualBuffer = Buffer.from(signatureHeader, 'utf8');

    if (expectedBuffer.length !== actualBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
  }

  /**
   * Register a new webhook endpoint for a business
   */
  static async registerEndpoint({ businessId, url, events }) {
    if (!url || !url.trim()) {
      throw new AppError('Webhook URL is required', 400, 'MISSING_URL');
    }

    const ssrfCheck = isSsrfSafeUrl(url.trim());
    if (!ssrfCheck.safe) {
      throw new AppError(`SSRF Protection Block: ${ssrfCheck.reason}`, 400, 'SSRF_BLOCKED');
    }

    const eventsList = Array.isArray(events) && events.length > 0
      ? events.filter(e => SUPPORTED_WEBHOOK_EVENTS.includes(e) || e === '*')
      : SUPPORTED_WEBHOOK_EVENTS;

    const endpointId = crypto.randomUUID();
    const secretKey = this.generateSecret();

    await pool.query(
      `INSERT INTO webhook_endpoints (
        id, business_id, url, secret_key, events_json, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, NOW(), NOW())`,
      [endpointId, businessId, url.trim(), secretKey, JSON.stringify(eventsList)]
    );

    return {
      id: endpointId,
      business_id: businessId,
      url: url.trim(),
      secret_key: secretKey,
      subscribed_events: eventsList,
      is_active: true,
      created_at: new Date().toISOString()
    };
  }

  /**
   * List registered endpoints for a business
   */
  static async listEndpoints(businessId) {
    const [rows] = await pool.query(
      `SELECT id, business_id, url, secret_key, events_json, is_active, created_at, updated_at
       FROM webhook_endpoints
       WHERE business_id = ?
       ORDER BY created_at DESC`,
      [businessId]
    );

    return rows.map(r => ({
      ...r,
      events_json: typeof r.events_json === 'string' ? JSON.parse(r.events_json) : r.events_json
    }));
  }

  /**
   * List delivery history for an endpoint
   */
  static async listDeliveries(endpointId, businessId) {
    const [endpoints] = await pool.query(
      'SELECT id FROM webhook_endpoints WHERE id = ? AND business_id = ?',
      [endpointId, businessId]
    );

    if (endpoints.length === 0) {
      throw new AppError('Webhook endpoint not found', 404, 'ENDPOINT_NOT_FOUND');
    }

    const [rows] = await pool.query(
      `SELECT id, endpoint_id, event_type, payload_json, response_status, response_body, attempt_count, status, created_at
       FROM webhook_deliveries
       WHERE endpoint_id = ?
       ORDER BY created_at DESC
       LIMIT 50`,
      [endpointId]
    );

    return rows.map(r => ({
      ...r,
      payload_json: typeof r.payload_json === 'string' ? JSON.parse(r.payload_json) : r.payload_json
    }));
  }

  /**
   * Deactivate or delete endpoint
   */
  static async deleteEndpoint(endpointId, businessId) {
    const [result] = await pool.query(
      'DELETE FROM webhook_endpoints WHERE id = ? AND business_id = ?',
      [endpointId, businessId]
    );

    if (result.affectedRows === 0) {
      throw new AppError('Webhook endpoint not found', 404, 'ENDPOINT_NOT_FOUND');
    }

    return { deleted: true, endpoint_id: endpointId };
  }

  /**
   * Dispatch an event to all matching subscribed webhook endpoints
   */
  static async dispatch(eventType, payload, targetBusinessId = null) {
    // Proactively notify registered parties via WhatsApp Business Bot
    setImmediate(async () => {
      try {
        const { default: ConversationEngine } = await import('../integrations/whatsapp/services/conversationEngine.js');
        await ConversationEngine.dispatchOutboundNotification(eventType, payload);
      } catch (err) {
        // Safe failover
      }
    });

    let querySql = 'SELECT * FROM webhook_endpoints WHERE is_active = 1';
    const params = [];

    if (targetBusinessId) {
      querySql += ' AND business_id = ?';
      params.push(targetBusinessId);
    }

    const [endpoints] = await pool.query(querySql, params);
    if (endpoints.length === 0) return [];

    const deliveryPromises = endpoints.map(async (ep) => {
      let events = [];
      try {
        events = typeof ep.events_json === 'string' ? JSON.parse(ep.events_json) : ep.events_json;
      } catch (e) {
        events = [];
      }

      // Check if endpoint is subscribed to this event or all events
      if (!events.includes('*') && !events.includes(eventType)) {
        return null;
      }

      const deliveryId = crypto.randomUUID();
      const payloadString = JSON.stringify({
        id: deliveryId,
        event: eventType,
        timestamp: new Date().toISOString(),
        data: payload
      });

      // SSRF check
      const ssrfCheck = isSsrfSafeUrl(ep.url);
      if (!ssrfCheck.safe) {
        await pool.query(
          `INSERT INTO webhook_deliveries (
            id, endpoint_id, event_type, payload_json, response_status, response_body, attempt_count, status, created_at
          ) VALUES (?, ?, ?, ?, 400, ?, 1, 'failed', NOW())`,
          [deliveryId, ep.id, eventType, payloadString, `SSRF Block: ${ssrfCheck.reason}`]
        );
        return { endpoint_id: ep.id, status: 'failed', error: ssrfCheck.reason };
      }

      const signature = this.computeSignature(payloadString, ep.secret_key);

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);

        const response = await fetch(ep.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Watchdog-Event': eventType,
            'X-Watchdog-Signature': signature,
            'User-Agent': 'Digital-Watchdog-Webhook/1.0'
          },
          body: payloadString,
          signal: controller.signal
        });

        clearTimeout(timeout);

        const responseText = await response.text().catch(() => '');
        const isSuccess = response.status >= 200 && response.status < 300;

        await pool.query(
          `INSERT INTO webhook_deliveries (
            id, endpoint_id, event_type, payload_json, response_status, response_body, attempt_count, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, NOW())`,
          [
            deliveryId,
            ep.id,
            eventType,
            payloadString,
            response.status,
            responseText.slice(0, 500),
            isSuccess ? 'success' : 'failed'
          ]
        );

        return {
          endpoint_id: ep.id,
          delivery_id: deliveryId,
          status: isSuccess ? 'success' : 'failed',
          status_code: response.status
        };
      } catch (err) {
        await pool.query(
          `INSERT INTO webhook_deliveries (
            id, endpoint_id, event_type, payload_json, response_status, response_body, attempt_count, status, created_at
          ) VALUES (?, ?, ?, ?, 0, ?, 1, 'failed', NOW())`,
          [deliveryId, ep.id, eventType, payloadString, err.message.slice(0, 500)]
        );

        return {
          endpoint_id: ep.id,
          delivery_id: deliveryId,
          status: 'failed',
          error: err.message
        };
      }
    });

    return Promise.all(deliveryPromises);
  }

  /**
   * Dispatch an immediate test ping delivery to verify endpoint responsiveness
   */
  static async dispatchTestPing(endpointId, businessId) {
    const [rows] = await pool.query(
      'SELECT * FROM webhook_endpoints WHERE id = ? AND business_id = ?',
      [endpointId, businessId]
    );

    if (rows.length === 0) {
      throw new AppError('Webhook endpoint not found', 404, 'ENDPOINT_NOT_FOUND');
    }

    const endpoint = rows[0];
    const testPayload = {
      event: 'test.ping',
      reference_no: 'DW-PING-TEST',
      message: 'This is a live test ping delivery from Digital Watchdog Developer Platform.',
      environment: 'sandbox',
      timestamp: new Date().toISOString()
    };

    const deliveryId = crypto.randomUUID();
    const payloadString = JSON.stringify({
      id: deliveryId,
      event: 'test.ping',
      timestamp: new Date().toISOString(),
      data: testPayload
    });

    const signature = this.computeSignature(payloadString, endpoint.secret_key);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);

      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Watchdog-Event': 'test.ping',
          'X-Watchdog-Signature': signature,
          'User-Agent': 'Digital-Watchdog-Webhook/1.0'
        },
        body: payloadString,
        signal: controller.signal
      });

      clearTimeout(timeout);
      const respText = await response.text().catch(() => '');
      const isSuccess = response.status >= 200 && response.status < 300;

      await pool.query(
        `INSERT INTO webhook_deliveries (
          id, endpoint_id, event_type, payload_json, response_status, response_body, attempt_count, status, created_at
        ) VALUES (?, ?, 'test.ping', ?, ?, ?, 1, ?, NOW())`,
        [deliveryId, endpoint.id, payloadString, response.status, respText.slice(0, 500), isSuccess ? 'success' : 'failed']
      );

      return {
        delivery_id: deliveryId,
        status_code: response.status,
        status: isSuccess ? 'success' : 'failed',
        signature
      };
    } catch (err) {
      await pool.query(
        `INSERT INTO webhook_deliveries (
          id, endpoint_id, event_type, payload_json, response_status, response_body, attempt_count, status, created_at
        ) VALUES (?, ?, 'test.ping', ?, 0, ?, 1, 'failed', NOW())`,
        [deliveryId, endpoint.id, payloadString, err.message.slice(0, 500)]
      );

      return {
        delivery_id: deliveryId,
        status_code: 0,
        status: 'failed',
        error: err.message,
        signature
      };
    }
  }
}

export default WebhookService;
