import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { startTestServer, stopTestServer, apiRequest } from './testHelper.js';
import pool, { closePool } from '../src/config/db.js';

describe('Obligations, Evidence, Payments & Deliveries (/api/v1/deals/:dealId/*)', () => {
  let alphaToken = '';
  let betaToken = '';
  let gammaToken = '';
  let dealId = '';
  let alphaBusinessId = '';
  let betaBusinessId = '';

  before(async () => {
    const { baseUrl } = await startTestServer();

    // 1. Login as Alpha Supplies (Supplier / Creator)
    const alphaLogin = await apiRequest('/api/v1/auth/login', {
      method: 'POST',
      body: {
        email: 'owner@alphasupplies.ng',
        password: 'Password123!'
      }
    });
    alphaToken = alphaLogin.data.data.token;
    alphaBusinessId = alphaLogin.data.data.business.id;

    // 2. Login as Beta Builders (Buyer / Counterparty)
    const betaLogin = await apiRequest('/api/v1/auth/login', {
      method: 'POST',
      body: {
        email: 'procurement@betabuilders.ng',
        password: 'Password123!'
      }
    });
    betaToken = betaLogin.data.data.token;
    betaBusinessId = betaLogin.data.data.business.id;

    // 3. Register Gamma Logistics (Unrelated tenant)
    const suffix = crypto.randomBytes(3).toString('hex');
    const gammaReg = await apiRequest('/api/v1/auth/register', {
      method: 'POST',
      body: {
        email: `ops_${suffix}@thirdparty.ng`,
        password: 'Password123!',
        full_name: 'Third Party Logistics',
        business_name: `Third Party Co ${suffix}`
      }
    });
    gammaToken = gammaReg.data.data.token;

    // 4. Create an active deal for testing obligations, evidence, payments, deliveries
    const dealRes = await apiRequest('/api/v1/deals', {
      method: 'POST',
      body: {
        title: 'Procurement of Pre-Stressed Concrete Beams (100 Units)',
        description: 'Complete manufacture, off-site curing, haulage, and delivery.',
        amount: 35000000.00,
        currency: 'NGN',
        terms_text: 'Milestone 1: 30% advance, Milestone 2: 50% batch delivery, Milestone 3: 20% retention.',
        invited_email: 'procurement@betabuilders.ng'
      },
      token: alphaToken
    });

    dealId = dealRes.data.data.id;
    const inviteToken = dealRes.data.data.invitation.token;

    // Counterparty accepts invitation
    await apiRequest(`/api/v1/deals/invitations/${inviteToken}/accept`, {
      method: 'POST',
      token: betaToken
    });

    // Both parties accept to activate the deal
    await apiRequest(`/api/v1/deals/${dealId}/accept`, { method: 'POST', token: alphaToken });
    await apiRequest(`/api/v1/deals/${dealId}/accept`, { method: 'POST', token: betaToken });
  });

  after(async () => {
    await stopTestServer();
    await closePool();
  });

  describe('1. Obligations Management', () => {
    let createdObligationId = '';
    let overdueObligationId = '';

    it('should create an obligation with due date and responsible business', async () => {
      const futureDueDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();

      const res = await apiRequest(`/api/v1/deals/${dealId}/obligations`, {
        method: 'POST',
        body: {
          title: 'Haulage of Batch 1 Concrete Beams',
          description: 'Deliver 50 beams to Eko Atlantic site',
          responsible_business_id: alphaBusinessId,
          type: 'delivery',
          due_date: futureDueDate
        },
        token: alphaToken
      });

      assert.equal(res.status, 201);
      assert.equal(res.data.success, true);
      assert.equal(res.data.data.title, 'Haulage of Batch 1 Concrete Beams');
      assert.equal(res.data.data.status, 'not_started');
      assert.equal(res.data.data.is_overdue, false);

      createdObligationId = res.data.data.id;
    });

    it('should compute is_overdue=true when due_date is in the past and status!=completed', async () => {
      const pastDueDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

      const res = await apiRequest(`/api/v1/deals/${dealId}/obligations`, {
        method: 'POST',
        body: {
          title: 'Foundation Soil Testing Lab Report',
          responsible_business_id: betaBusinessId,
          type: 'inspection',
          due_date: pastDueDate
        },
        token: betaToken
      });

      assert.equal(res.status, 201);
      assert.equal(res.data.data.is_overdue, true);

      overdueObligationId = res.data.data.id;
    });

    it('should list all obligations for the deal with computed overdue flags', async () => {
      const res = await apiRequest(`/api/v1/deals/${dealId}/obligations`, {
        token: alphaToken
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.ok(res.data.data.count >= 2);

      const overdueObj = res.data.data.obligations.find(o => o.id === overdueObligationId);
      assert.ok(overdueObj);
      assert.equal(Boolean(overdueObj.is_overdue), true);

      const normalObj = res.data.data.obligations.find(o => o.id === createdObligationId);
      assert.ok(normalObj);
      assert.equal(Boolean(normalObj.is_overdue), false);
    });

    it('should update obligation status to in_progress and then to completed', async () => {
      // Transition to in_progress
      const inProgRes = await apiRequest(`/api/v1/deals/${dealId}/obligations/${createdObligationId}/status`, {
        method: 'PATCH',
        body: { status: 'in_progress' },
        token: alphaToken
      });

      assert.equal(inProgRes.status, 200);
      assert.equal(inProgRes.data.data.status, 'in_progress');
      assert.equal(inProgRes.data.data.completion_date, null);

      // Transition to completed
      const compRes = await apiRequest(`/api/v1/deals/${dealId}/obligations/${createdObligationId}/status`, {
        method: 'PATCH',
        body: { status: 'completed' },
        token: alphaToken
      });

      assert.equal(compRes.status, 200);
      assert.equal(compRes.data.data.status, 'completed');
      assert.ok(compRes.data.data.completion_date);
    });

    it('should extend deadline without erasing original deadline and audit event', async () => {
      const newDueDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

      const res = await apiRequest(`/api/v1/deals/${dealId}/obligations/${overdueObligationId}/extend-deadline`, {
        method: 'PATCH',
        body: {
          new_due_date: newDueDate,
          reason: 'Severe rain delay at testing site'
        },
        token: alphaToken
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.ok(res.data.data.original_due_date);
      assert.notEqual(res.data.data.due_date, res.data.data.original_due_date);
      assert.equal(res.data.data.is_overdue, false);
    });
  });

  describe('2. Evidence Management & Secure Storage', () => {
    let uploadedEvidenceId = '';

    it('should upload evidence document linked to deal and obligation', async () => {
      // Create FormData with a dummy PDF file
      const formData = new FormData();
      const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // '%PDF-1.4'
      const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });

      formData.append('file', pdfBlob, 'quality_assurance_test_cert.pdf');
      formData.append('notes', 'Official structural certification from Standards Organisation of Nigeria.');

      const { apiUploadRequest } = await import('./testHelper.js');
      const res = await apiUploadRequest(`/api/v1/deals/${dealId}/evidence`, {
        formData,
        token: alphaToken
      });

      assert.equal(res.status, 201);
      assert.equal(res.data.success, true);
      assert.equal(res.data.data.file_name, 'quality_assurance_test_cert.pdf');
      assert.equal(res.data.data.verification_tier, 'submitted');
      assert.ok(res.data.data.id);
    });

    it('should reject upload with disallowed MIME type', async () => {
      const formData = new FormData();
      const textBlob = new Blob(['plain text not allowed'], { type: 'text/plain' });
      formData.append('file', textBlob, 'notes.txt');

      const { apiUploadRequest } = await import('./testHelper.js');
      const res = await apiUploadRequest(`/api/v1/deals/${dealId}/evidence`, {
        formData,
        token: alphaToken
      });

      assert.equal(res.status, 400);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'INVALID_MIME_TYPE');
    });

    it('should list evidence records submitted for the deal', async () => {
      // Directly insert an evidence record to test listing and downloading comprehensively
      const evidenceId = crypto.randomUUID();
      const storageService = (await import('../src/services/storageService.js')).default;

      // Save a real dummy file via storageService
      const stored = await storageService.saveFile({
        originalname: 'mill_test_certificate.pdf',
        mimetype: 'application/pdf',
        size: 1024,
        buffer: Buffer.from('%PDF-1.4 Mock Mill Test Certificate for Rebar Beams')
      }, dealId);

      await pool.query(
        `INSERT INTO evidence_records (
          id, deal_id, submitted_by_business_id, submitted_by_user_id,
          file_path, file_name, file_size, mime_type, verification_tier, notes, created_at
        ) VALUES (?, ?, ?, (SELECT id FROM users WHERE email = 'owner@alphasupplies.ng'), ?, ?, ?, ?, 'submitted', 'Mill QA Cert', NOW())`,
        [evidenceId, dealId, alphaBusinessId, stored.filePath, stored.fileName, stored.fileSize, stored.mimeType]
      );

      uploadedEvidenceId = evidenceId;

      const res = await apiRequest(`/api/v1/deals/${dealId}/evidence`, {
        token: alphaToken
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.ok(res.data.data.count >= 1);
      assert.ok(res.data.data.evidence.some(e => e.id === evidenceId));
    });

    it('should stream evidence file for authorized tenant', async () => {
      const res = await apiRequest(`/api/v1/deals/${dealId}/evidence/${uploadedEvidenceId}/download`, {
        token: betaToken // counterparty tenant
      });

      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/pdf');
    });

    it('should deny evidence download to unauthorized 3rd party tenant', async () => {
      const res = await apiRequest(`/api/v1/deals/${dealId}/evidence/${uploadedEvidenceId}/download`, {
        token: gammaToken
      });

      assert.equal(res.status, 403);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'FORBIDDEN');
    });
  });

  describe('3. Payment Records Ledger', () => {
    let recordedPaymentId = '';

    it('should record a reported payment and calculate ledger balance', async () => {
      const res = await apiRequest(`/api/v1/deals/${dealId}/payments`, {
        method: 'POST',
        body: {
          expected_amount: 10500000.00,
          reported_amount: 10500000.00,
          currency: 'NGN',
          reference_no: 'TRX-NIBSS-2026-BB-00129',
          notes: 'Advance mobilization payment via Zenith NIBSS Instant Transfer'
        },
        token: betaToken // Buyer / Payer
      });

      assert.equal(res.status, 201);
      assert.equal(res.data.success, true);
      assert.equal(res.data.data.status, 'reported');
      assert.equal(res.data.data.reported_amount, 10500000.00);

      recordedPaymentId = res.data.data.id;
    });

    it('should allow recipient business to acknowledge and confirm payment', async () => {
      // Recipient (Alpha Supplies) confirms the payment
      const confirmRes = await apiRequest(`/api/v1/deals/${dealId}/payments/${recordedPaymentId}/status`, {
        method: 'PATCH',
        body: { status: 'confirmed' },
        token: alphaToken
      });

      assert.equal(confirmRes.status, 200);
      assert.equal(confirmRes.data.success, true);
      assert.equal(confirmRes.data.data.status, 'confirmed');
      assert.ok(confirmRes.data.data.paid_at);
    });

    it('should forbid payer from confirming their own payment', async () => {
      // Buyer (Beta Builders) cannot confirm their own payment to themselves
      const res = await apiRequest(`/api/v1/deals/${dealId}/payments/${recordedPaymentId}/status`, {
        method: 'PATCH',
        body: { status: 'confirmed' },
        token: betaToken
      });

      assert.equal(res.status, 403);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'FORBIDDEN_PAYMENT_CONFIRMATION');
    });

    it('should return financial summary with reported, confirmed, and outstanding balance', async () => {
      const res = await apiRequest(`/api/v1/deals/${dealId}/payments`, {
        token: alphaToken
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.ok(res.data.data.financial_summary);

      const summary = res.data.data.financial_summary;
      assert.equal(summary.total_agreed_amount, 35000000.00);
      assert.equal(summary.total_confirmed, 10500000.00);
      assert.equal(summary.outstanding_balance, 24500000.00);
    });
  });

  describe('4. Delivery Records Ledger', () => {
    let recordedDeliveryId = '';

    it('should record delivery dispatch with item manifest JSON', async () => {
      const items = [
        {
          code: 'BM-S355-12M',
          description: '12-Meter Pre-Stressed Concrete Girder Beam',
          quantity: 25,
          unit: 'units',
          batch_id: 'ECH-CON-B-019'
        }
      ];

      const res = await apiRequest(`/api/v1/deals/${dealId}/deliveries`, {
        method: 'POST',
        body: {
          items_json: items,
          delivery_reference: 'WAYBILL-ECH-2026-9901',
          notes: 'Trailers dispatched under military escort via Sagamu-Benin expressway.'
        },
        token: alphaToken
      });

      assert.equal(res.status, 201);
      assert.equal(res.data.success, true);
      assert.equal(res.data.data.status, 'dispatched');
      assert.equal(res.data.data.delivery_reference, 'WAYBILL-ECH-2026-9901');
      assert.equal(res.data.data.items_json.length, 1);

      recordedDeliveryId = res.data.data.id;
    });

    it('should allow recipient to update delivery status with discrepancy note', async () => {
      const res = await apiRequest(`/api/v1/deals/${dealId}/deliveries/${recordedDeliveryId}/status`, {
        method: 'PATCH',
        body: {
          status: 'acknowledged_with_discrepancy',
          discrepancy_notes: '1 beam sustained micro-fracture hairline cracks during offloading.'
        },
        token: betaToken
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.equal(res.data.data.status, 'acknowledged_with_discrepancy');
      assert.ok(res.data.data.receipt_date);
      assert.match(res.data.data.notes, /micro-fracture/);
    });

    it('should list delivery history for the deal', async () => {
      const res = await apiRequest(`/api/v1/deals/${dealId}/deliveries`, {
        token: betaToken
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.ok(res.data.data.count >= 1);
      assert.ok(res.data.data.deliveries.some(d => d.id === recordedDeliveryId));
    });
  });

  describe('5. Audit Trail Verification for All Operations', () => {
    it('should have logged chronological activity events for all operations', async () => {
      const res = await apiRequest(`/api/v1/deals/${dealId}/activity`, {
        token: alphaToken
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);

      const eventTypes = res.data.data.timeline.map(t => t.event_type);

      assert.ok(eventTypes.includes('obligation.created'), 'Should record obligation.created');
      assert.ok(eventTypes.includes('obligation.status_updated'), 'Should record obligation.status_updated');
      assert.ok(eventTypes.includes('obligation.completed'), 'Should record obligation.completed');
      assert.ok(eventTypes.includes('obligation.deadline_extended'), 'Should record obligation.deadline_extended');
      assert.ok(eventTypes.includes('payment.reported'), 'Should record payment.reported');
      assert.ok(eventTypes.includes('payment.confirmed'), 'Should record payment.confirmed');
      assert.ok(eventTypes.includes('delivery.dispatched'), 'Should record delivery.dispatched');
      assert.ok(eventTypes.includes('delivery.discrepancy_reported'), 'Should record delivery.discrepancy_reported');
    });
  });
});
