import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { startTestServer, stopTestServer, apiRequest, apiUploadRequest } from './testHelper.js';
import { WebhookService } from '../src/services/webhookService.js';
import pool, { closePool } from '../src/config/db.js';

describe('End-to-End Multi-Tenant Accountable Lifecycle Verification', () => {
  let tokenA = '';
  let businessA = null;
  let userA = null;

  let tokenB = '';
  let businessB = null;
  let userB = null;

  let tokenC = '';
  let businessC = null;
  let userC = null;

  let dealId = '';
  let invitationToken = '';
  let obligationId = '';
  let evidenceId = '';
  let disputeId = '';

  const suffix = crypto.randomBytes(3).toString('hex');

  before(async () => {
    await startTestServer();
  });

  after(async () => {
    await stopTestServer();
    await closePool();
  });

  // --------------------------------------------------------------------------
  // Test 1: User Registration & Business Profile Setup
  // --------------------------------------------------------------------------
  it('Test 1: User registration and business profile setup for Tenant A, B, and C', async () => {
    // 1. Register Business A
    const resA = await apiRequest('/api/v1/auth/register', {
      method: 'POST',
      body: {
        email: `founder_${suffix}@alphatrade.ng`,
        password: 'Password123!',
        full_name: 'Ibrahim Alfa',
        phone: '+2348011110001',
        business_name: `Alpha Trade Hub ${suffix}`,
        rc_number: `RC-ALPHA-${suffix}`,
        address: 'Plot 10, Victoria Island, Lagos'
      }
    });

    assert.equal(resA.status, 201, `Failed to register Business A: ${JSON.stringify(resA.data)}`);
    assert.equal(resA.data.success, true);
    assert.ok(resA.data.data.token);
    assert.ok(resA.data.data.business?.id);
    tokenA = resA.data.data.token;
    userA = resA.data.data.user;
    businessA = resA.data.data.business;

    // 2. Register Business B
    const resB = await apiRequest('/api/v1/auth/register', {
      method: 'POST',
      body: {
        email: `buyer_${suffix}@betabuild.ng`,
        password: 'Password123!',
        full_name: 'Folake Beta',
        phone: '+2348011110002',
        business_name: `Beta Build Corp ${suffix}`,
        rc_number: `RC-BETA-${suffix}`,
        address: 'Kilometer 14, Lekki Expressway, Lagos'
      }
    });

    assert.equal(resB.status, 201);
    assert.equal(resB.data.success, true);
    tokenB = resB.data.data.token;
    userB = resB.data.data.user;
    businessB = resB.data.data.business;

    // 3. Register Business C (Unrelated 3rd Party)
    const resC = await apiRequest('/api/v1/auth/register', {
      method: 'POST',
      body: {
        email: `intruder_${suffix}@gammalogistics.ng`,
        password: 'Password123!',
        full_name: 'Gideon Gamma',
        business_name: `Gamma Freight Solutions ${suffix}`
      }
    });

    assert.equal(resC.status, 201);
    assert.equal(resC.data.success, true);
    tokenC = resC.data.data.token;
    userC = resC.data.data.user;
    businessC = resC.data.data.business;
  });

  // --------------------------------------------------------------------------
  // Test 2: Deal Creation by Business A and Invitation to Business B
  // --------------------------------------------------------------------------
  it('Test 2: Deal creation by Business A and invitation to Business B', async () => {
    const res = await apiRequest('/api/v1/deals', {
      method: 'POST',
      token: tokenA,
      body: {
        title: `Procurement of Industrial Generators ${suffix}`,
        description: 'Contract for supply and delivery of 3x commercial 500kVA generators.',
        amount: 35000000.00,
        currency: 'NGN',
        invited_email: userB.email,
        terms_text: '1. Standard Warranty of 2 years.\n2. 50% mobilization advance.\n3. Inspection sign-off required prior to final settlement.'
      }
    });

    assert.equal(res.status, 201, `Create deal failed: ${JSON.stringify(res.data)}`);
    assert.equal(res.data.success, true);
    assert.equal(res.data.data.status, 'draft');
    assert.equal(res.data.data.current_version, 1);
    assert.ok(res.data.data.id);
    assert.ok(res.data.data.invitation?.token);

    dealId = res.data.data.id;
    invitationToken = res.data.data.invitation.token;
  });

  // --------------------------------------------------------------------------
  // Test 3: Business B Acceptance of Terms; Deal Transitions to 'active'
  // --------------------------------------------------------------------------
  it('Test 3: Business B acceptance of terms; deal transitions to active', async () => {
    // 1. Business B accepts invitation token
    const acceptInviteRes = await apiRequest(`/api/v1/deals/invitations/${invitationToken}/accept`, {
      method: 'POST',
      token: tokenB
    });

    assert.equal(acceptInviteRes.status, 200, `Accept invitation failed: ${JSON.stringify(acceptInviteRes.data)}`);
    assert.equal(acceptInviteRes.data.success, true);

    // 2. Business A formally accepts Version 1 terms
    const acceptARes = await apiRequest(`/api/v1/deals/${dealId}/accept`, {
      method: 'POST',
      token: tokenA
    });
    assert.equal(acceptARes.status, 200);

    // 3. Business B formally accepts Version 1 terms
    const acceptBRes = await apiRequest(`/api/v1/deals/${dealId}/accept`, {
      method: 'POST',
      token: tokenB
    });
    assert.equal(acceptBRes.status, 200);
    assert.equal(acceptBRes.data.data.activated, true);
    assert.equal(acceptBRes.data.data.deal_status, 'active');

    // 4. Verify deal state is now 'active'
    const dealRes = await apiRequest(`/api/v1/deals/${dealId}`, {
      method: 'GET',
      token: tokenA
    });
    assert.equal(dealRes.status, 200);
    assert.equal(dealRes.data.data.deal.status, 'active');
    assert.equal(dealRes.data.data.acceptances_status.fully_accepted, true);
  });

  // --------------------------------------------------------------------------
  // Test 4: Tenant Isolation Check - Business C Access Denied (HTTP 403)
  // --------------------------------------------------------------------------
  it('Test 4: Tenant Isolation Check: Business C tries to fetch Business A & B deal -> returns HTTP 403', async () => {
    // 1. Direct fetch attempt by unauthorized Business C
    const unauthorizedRes = await apiRequest(`/api/v1/deals/${dealId}`, {
      method: 'GET',
      token: tokenC
    });

    assert.equal(unauthorizedRes.status, 403);
    assert.equal(unauthorizedRes.data.success, false);
    assert.equal(unauthorizedRes.data.error.code, 'FORBIDDEN');

    // 2. Business C lists deals -> must NOT contain Business A & B deal
    const listRes = await apiRequest('/api/v1/deals', {
      method: 'GET',
      token: tokenC
    });

    assert.equal(listRes.status, 200);
    const deals = listRes.data.data.deals;
    const found = deals.some(d => d.id === dealId);
    assert.equal(found, false, 'Tenant isolation breach: Unrelated deal appeared in Business C list');
  });

  // --------------------------------------------------------------------------
  // Test 5: Obligation Creation and Status Update
  // --------------------------------------------------------------------------
  it('Test 5: Obligation creation and status update', async () => {
    // 1. Create Obligation for Business B (Mobilization Payment)
    const createObRes = await apiRequest(`/api/v1/deals/${dealId}/obligations`, {
      method: 'POST',
      token: tokenA,
      body: {
        title: '50% Mobilization Deposit Milestone',
        description: 'Deposit 17,500,000 NGN into designated escrow settlement account.',
        responsible_business_id: businessB.id,
        type: 'payment',
        due_date: new Date(Date.now() + 86400000 * 2).toISOString()
      }
    });

    assert.equal(createObRes.status, 201);
    assert.equal(createObRes.data.success, true);
    assert.equal(createObRes.data.data.status, 'not_started');
    obligationId = createObRes.data.data.id;

    // 2. Update status to in_progress
    const inProgRes = await apiRequest(`/api/v1/deals/${dealId}/obligations/${obligationId}/status`, {
      method: 'PATCH',
      token: tokenB,
      body: {
        status: 'in_progress',
        notes: 'Wire transfer initiated from corporate account.'
      }
    });
    assert.equal(inProgRes.status, 200);
    assert.equal(inProgRes.data.data.status, 'in_progress');

    // 3. Update status to completed
    const completedRes = await apiRequest(`/api/v1/deals/${dealId}/obligations/${obligationId}/status`, {
      method: 'PATCH',
      token: tokenB,
      body: {
        status: 'completed',
        notes: 'Deposit confirmed by settlement clearing house.'
      }
    });
    assert.equal(completedRes.status, 200);
    assert.equal(completedRes.data.data.status, 'completed');
    assert.ok(completedRes.data.data.completion_date);
  });

  // --------------------------------------------------------------------------
  // Test 6: Evidence Upload and Download Authorization Check
  // --------------------------------------------------------------------------
  it('Test 6: Evidence upload and download authorization check', async () => {
    // 1. Upload mock PDF document by Business B
    const formData = new FormData();
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // '%PDF-1.4'
    const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });
    formData.append('file', pdfBlob, 'bank_transfer_slip.pdf');
    formData.append('obligation_id', obligationId);
    formData.append('notes', 'Official bank transfer confirmation receipt');

    const uploadRes = await apiUploadRequest(`/api/v1/deals/${dealId}/evidence`, {
      formData,
      token: tokenB
    });

    assert.equal(uploadRes.status, 201, `Upload failed: ${JSON.stringify(uploadRes.data)}`);
    assert.equal(uploadRes.data.success, true);
    assert.equal(uploadRes.data.data.file_name, 'bank_transfer_slip.pdf');
    evidenceId = uploadRes.data.data.id;

    // 2. Authorized participant (Business A) downloads evidence -> HTTP 200
    const authDownload = await apiRequest(`/api/v1/deals/${dealId}/evidence/${evidenceId}/download`, {
      method: 'GET',
      token: tokenA
    });
    assert.equal(authDownload.status, 200);

    // 3. Unauthorized 3rd party (Business C) tries to download -> HTTP 403 Forbidden
    const unauthDownload = await apiRequest(`/api/v1/deals/${dealId}/evidence/${evidenceId}/download`, {
      method: 'GET',
      token: tokenC
    });
    assert.equal(unauthDownload.status, 403);
  });

  // --------------------------------------------------------------------------
  // Test 7: Dispute Filing Transitions Deal to 'disputed'
  // --------------------------------------------------------------------------
  it('Test 7: Dispute filing transitions deal to disputed', async () => {
    const disputeRes = await apiRequest(`/api/v1/deals/${dealId}/disputes`, {
      method: 'POST',
      token: tokenB,
      body: {
        category: 'delivery_delay',
        description: 'Manufacturer delay on primary alternator components exceeds scheduled timeline.',
        obligation_id: obligationId
      }
    });

    assert.equal(disputeRes.status, 201);
    assert.equal(disputeRes.data.success, true);
    assert.equal(disputeRes.data.data.status, 'open');
    disputeId = disputeRes.data.data.id;

    // Verify Deal state is now 'disputed'
    const dealRes = await apiRequest(`/api/v1/deals/${dealId}`, {
      method: 'GET',
      token: tokenA
    });
    assert.equal(dealRes.status, 200);
    assert.equal(dealRes.data.data.deal.status, 'disputed');
  });

  // --------------------------------------------------------------------------
  // Test 8: Webhook HMAC Signature Verification
  // --------------------------------------------------------------------------
  it('Test 8: Webhook HMAC signature verification', () => {
    const secret = 'whsec_test_secret_key_super_secure_32_bytes_long';
    const payload = JSON.stringify({
      event: 'deal.status_changed',
      deal_id: dealId,
      status: 'disputed',
      timestamp: new Date().toISOString()
    });

    // 1. Compute HMAC signature using SHA-256
    const signatureHeader = WebhookService.computeSignature(payload, secret);
    assert.match(signatureHeader, /^sha256=[a-f0-9]{64}$/);

    // 2. Validate timing-safe verification accepts identical payload
    const isValid = WebhookService.verifySignature(payload, signatureHeader, secret);
    assert.equal(isValid, true, 'Genuine HMAC signature should verify successfully');

    // 3. Tampered payload MUST fail verification
    const tamperedPayload = payload.replace('"disputed"', '"completed"');
    const isTamperedValid = WebhookService.verifySignature(tamperedPayload, signatureHeader, secret);
    assert.equal(isTamperedValid, false, 'Tampered payload should fail HMAC verification');

    // 4. Incorrect secret MUST fail verification
    const isWrongSecretValid = WebhookService.verifySignature(payload, signatureHeader, 'whsec_wrong_key');
    assert.equal(isWrongSecretValid, false, 'Wrong secret should fail HMAC verification');
  });
});
