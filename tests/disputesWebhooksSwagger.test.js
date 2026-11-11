import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { startTestServer, stopTestServer, apiRequest } from './testHelper.js';
import pool, { closePool } from '../src/config/db.js';
import WebhookService, { isSsrfSafeUrl } from '../src/services/webhookService.js';

describe('Disputes, HMAC Webhooks & Swagger Documentation', () => {
  let alphaToken = '';
  let betaToken = '';
  let gammaToken = '';
  let dealId = '';

  before(async () => {
    await startTestServer();

    // Login Alpha Supplies
    const alphaLogin = await apiRequest('/api/v1/auth/login', {
      method: 'POST',
      body: {
        email: 'owner@alphasupplies.ng',
        password: 'Password123!'
      }
    });
    alphaToken = alphaLogin.data.data.token;

    // Login Beta Builders
    const betaLogin = await apiRequest('/api/v1/auth/login', {
      method: 'POST',
      body: {
        email: 'procurement@betabuilders.ng',
        password: 'Password123!'
      }
    });
    betaToken = betaLogin.data.data.token;

    // Register Gamma
    const suffix = crypto.randomBytes(3).toString('hex');
    const gammaReg = await apiRequest('/api/v1/auth/register', {
      method: 'POST',
      body: {
        email: `ops_${suffix}@thirdparty2.ng`,
        password: 'Password123!',
        full_name: 'Third Party Co',
        business_name: `Third Party Two ${suffix}`
      }
    });
    gammaToken = gammaReg.data.data.token;

    // Create an active deal for dispute tests
    const dealRes = await apiRequest('/api/v1/deals', {
      method: 'POST',
      body: {
        title: 'Reinforced Concrete Drainage Culverts (500m)',
        description: 'Supply of pre-cast drainage culverts for storm-water civil works.',
        amount: 19500000.00,
        currency: 'NGN',
        terms_text: 'Culverts to be delivered in 2 batches of 250 meters each.',
        invited_email: 'procurement@betabuilders.ng'
      },
      token: alphaToken
    });

    dealId = dealRes.data.data.id;
    const inviteToken = dealRes.data.data.invitation.token;

    // Counterparty accepts invite
    await apiRequest(`/api/v1/deals/invitations/${inviteToken}/accept`, {
      method: 'POST',
      token: betaToken
    });

    // Dual accept to activate deal
    await apiRequest(`/api/v1/deals/${dealId}/accept`, { method: 'POST', token: alphaToken });
    await apiRequest(`/api/v1/deals/${dealId}/accept`, { method: 'POST', token: betaToken });
  });

  after(async () => {
    await stopTestServer();
    await closePool();
  });

  describe('1. Dispute Management Workflow', () => {
    let disputeId = '';

    it('should allow party to open a dispute and transition deal to disputed status', async () => {
      const res = await apiRequest(`/api/v1/deals/${dealId}/disputes`, {
        method: 'POST',
        body: {
          category: 'Delivery Specification Defect',
          description: 'Batch 1 precast culverts dimension variance exceeds 5mm tolerance limit.'
        },
        token: betaToken // Raised by Buyer
      });

      assert.equal(res.status, 201);
      assert.equal(res.data.success, true);
      assert.equal(res.data.data.status, 'open');
      assert.equal(res.data.data.category, 'Delivery Specification Defect');

      disputeId = res.data.data.id;

      // Verify deal status changed to 'disputed'
      const dealRes = await apiRequest(`/api/v1/deals/${dealId}`, { token: alphaToken });
      assert.equal(dealRes.data.data.deal.status, 'disputed');
    });

    it('should list disputes for the deal', async () => {
      const res = await apiRequest(`/api/v1/deals/${dealId}/disputes`, {
        token: alphaToken
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.ok(res.data.data.count >= 1);
      assert.ok(res.data.data.disputes.some(d => d.id === disputeId));
    });

    it('should allow counterparty to respond with counter-terms and update status to resolution_proposed', async () => {
      const res = await apiRequest(`/api/v1/deals/${dealId}/disputes/${disputeId}/response`, {
        method: 'POST',
        body: {
          response_text: 'Supplier quality engineering team inspected batch. 40 units require shimming.',
          proposed_terms: 'Supplier will replace 40 units at zero cost and extend installation warranty by 6 months.'
        },
        token: alphaToken // Responded by Supplier
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.equal(res.data.data.status, 'resolution_proposed');
      assert.match(res.data.data.resolution_terms, /replace 40 units/i);
    });

    it('should resolve dispute and automatically revert deal status to active', async () => {
      const res = await apiRequest(`/api/v1/deals/${dealId}/disputes/${disputeId}/resolve`, {
        method: 'POST',
        body: {
          resolution_terms: 'Mutual sign-off: Replacement units delivered and QA certified.',
          resolution_action: 'resume_active'
        },
        token: betaToken
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.equal(res.data.data.dispute.status, 'resolved');
      assert.ok(res.data.data.dispute.resolved_at);
      assert.equal(res.data.data.deal_status, 'active');

      // Verify deal in DB is active again
      const dealRes = await apiRequest(`/api/v1/deals/${dealId}`, { token: alphaToken });
      assert.equal(dealRes.data.data.deal.status, 'active');
    });

    it('should verify dispute events in deal activity audit timeline', async () => {
      const res = await apiRequest(`/api/v1/deals/${dealId}/activity`, {
        token: alphaToken
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);

      const eventTypes = res.data.data.timeline.map(t => t.event_type);
      assert.ok(eventTypes.includes('dispute.opened'));
      assert.ok(eventTypes.includes('dispute.response_submitted'));
      assert.ok(eventTypes.includes('dispute.resolved'));
    });
  });

  describe('2. HMAC-SHA256 Webhook Signing & SSRF Protection', () => {
    it('should compute and verify valid HMAC-SHA256 signatures', () => {
      const secretKey = 'whsec_test_secret_key_12345';
      const payloadString = JSON.stringify({
        id: 'del_123',
        event: 'deal.activated',
        timestamp: '2026-10-19T14:00:00Z',
        data: { deal_id: 'deal_xyz' }
      });

      const signature = WebhookService.computeSignature(payloadString, secretKey);
      assert.ok(signature.startsWith('sha256='));

      // Valid signature verification
      const isValid = WebhookService.verifySignature(payloadString, signature, secretKey);
      assert.equal(isValid, true, 'Valid signature must verify successfully');

      // Invalid signature rejection
      const isInvalid = WebhookService.verifySignature(payloadString, 'sha256=badhex9999999999', secretKey);
      assert.equal(isInvalid, false, 'Invalid signature must be rejected');

      // Tampered payload rejection
      const isTampered = WebhookService.verifySignature(payloadString + 'tamper', signature, secretKey);
      assert.equal(isTampered, false, 'Tampered payload must be rejected');
    });

    it('should enforce SSRF protection blocking loopback and RFC1918 private IP ranges', () => {
      // Loopback
      assert.equal(isSsrfSafeUrl('http://localhost:8080/hook').safe, false);
      assert.equal(isSsrfSafeUrl('http://127.0.0.1:3000/webhook').safe, false);
      assert.equal(isSsrfSafeUrl('http://127.0.0.2:80/hook').safe, false);

      // Private RFC1918 ranges
      assert.equal(isSsrfSafeUrl('http://10.0.0.1/webhook').safe, false);
      assert.equal(isSsrfSafeUrl('http://172.16.0.1/webhook').safe, false);
      assert.equal(isSsrfSafeUrl('http://172.31.255.255/hook').safe, false);
      assert.equal(isSsrfSafeUrl('http://192.168.1.100/webhook').safe, false);

      // Link-local / Cloud Metadata (169.254.169.254)
      assert.equal(isSsrfSafeUrl('http://169.254.169.254/latest/meta-data').safe, false);

      // Valid public internet domains
      assert.equal(isSsrfSafeUrl('https://api.betabuilders.ng/webhooks/digital-watchdog').safe, true);
      assert.equal(isSsrfSafeUrl('https://hooks.slack.com/services/T00/B00/X00').safe, true);
    });

    it('should reject webhook registration with SSRF blocked loopback URL', async () => {
      const res = await apiRequest('/api/v1/webhooks', {
        method: 'POST',
        body: {
          url: 'http://127.0.0.1:5000/internal-callback',
          events: ['deal.activated']
        },
        token: alphaToken
      });

      assert.equal(res.status, 400);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'SSRF_BLOCKED');
    });

    it('should register a valid public webhook endpoint with shared secret', async () => {
      const res = await apiRequest('/api/v1/webhooks', {
        method: 'POST',
        body: {
          url: 'https://erp.alphasupplies.ng/api/v1/watchdog-webhooks',
          events: ['deal.activated', 'dispute.opened', 'dispute.resolved']
        },
        token: alphaToken
      });

      assert.equal(res.status, 201);
      assert.equal(res.data.success, true);
      assert.ok(res.data.data.id);
      assert.ok(res.data.data.secret_key.startsWith('whsec_'));
      assert.equal(res.data.data.is_active, true);
      assert.ok(Array.isArray(res.data.data.subscribed_events));

      const endpointId = res.data.data.id;

      // List webhooks
      const listRes = await apiRequest('/api/v1/webhooks', { token: alphaToken });
      assert.equal(listRes.status, 200);
      assert.ok(listRes.data.data.endpoints.some(e => e.id === endpointId));

      // List deliveries
      const deliveriesRes = await apiRequest(`/api/v1/webhooks/${endpointId}/deliveries`, { token: alphaToken });
      assert.equal(deliveriesRes.status, 200);
      assert.ok(Array.isArray(deliveriesRes.data.data.deliveries));

      // Delete webhook
      const delRes = await apiRequest(`/api/v1/webhooks/${endpointId}`, {
        method: 'DELETE',
        token: alphaToken
      });
      assert.equal(delRes.status, 200);
      assert.equal(delRes.data.data.deleted, true);
    });
  });

  describe('3. OpenAPI / Swagger Documentation Endpoints', () => {
    it('should serve OpenAPI 3.0.3 specification JSON at /api/v1/docs/swagger.json', async () => {
      const res = await apiRequest('/api/v1/docs/swagger.json');

      assert.equal(res.status, 200);
      assert.equal(res.data.openapi, '3.0.3');
      assert.equal(res.data.info.title, 'Digital Watchdog API');
      assert.ok(res.data.components.securitySchemes.BearerAuth);
      assert.ok(res.data.paths['/auth/register']);
      assert.ok(res.data.paths['/auth/login']);
      assert.ok(res.data.paths['/deals']);
      assert.ok(res.data.paths['/deals/{dealId}']);
      assert.ok(res.data.paths['/deals/{dealId}/disputes']);
      assert.ok(res.data.paths['/deals/{dealId}/evidence']);
      assert.ok(res.data.paths['/deals/{dealId}/payments']);
      assert.ok(res.data.paths['/deals/{dealId}/deliveries']);
      assert.ok(res.data.paths['/webhooks']);
    });

    it('should serve Swagger UI at /api/v1/docs', async () => {
      const { getBaseUrl } = await import('./testHelper.js');
      const response = await fetch(`${getBaseUrl()}/api/v1/docs/`);

      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /swagger-ui/i);
    });
  });
});
