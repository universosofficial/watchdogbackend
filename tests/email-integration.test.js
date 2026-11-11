import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { startTestServer, stopTestServer, apiRequest } from './testHelper.js';
import pool, { closePool } from '../src/config/db.js';
import EmailActionService from '../src/integrations/email/services/emailActionService.js';
import emailClient from '../src/integrations/email/services/emailClient.js';
import { MultiChannelNotifier } from '../src/integrations/multiChannelNotifier.js';
import { DealService } from '../src/services/dealService.js';

describe('Transactional Email & 1-Click Actions Integration Tests', () => {
  let alphaUser, betaUser, alphaBiz, betaBiz;

  before(async () => {
    await startTestServer();

    // Query seeded users and businesses
    const [users] = await pool.query(
      `SELECT u.id, u.email, bm.business_id, b.name as business_name 
       FROM users u 
       JOIN business_members bm ON u.id = bm.user_id 
       JOIN businesses b ON bm.business_id = b.id 
       ORDER BY u.email ASC`
    );
    alphaUser = users.find(u => u.email === 'owner@alphasupplies.ng');
    betaUser = users.find(u => u.email === 'procurement@betabuilders.ng');
    alphaBiz = alphaUser.business_id;
    betaBiz = betaUser.business_id;
  });

  after(async () => {
    await stopTestServer();
  });

  beforeEach(() => {
    emailClient.clearMockInbox();
  });

  describe('1. Cryptographic Action Tokens', () => {
    it('should generate a verifiable signed token', () => {
      const payload = { dealId: 'test-deal-1', businessId: betaBiz, userId: betaUser.id };
      const token = EmailActionService.generateActionToken('accept_deal', payload, 3600000);

      assert.ok(token);
      assert.ok(token.includes('.'));

      const decoded = EmailActionService.verifyActionToken(token);
      assert.equal(decoded.action, 'accept_deal');
      assert.equal(decoded.payload.dealId, 'test-deal-1');
      assert.equal(decoded.payload.businessId, betaBiz);
    });

    it('should reject tampered action tokens', () => {
      const payload = { dealId: 'test-deal-1', businessId: betaBiz };
      const token = EmailActionService.generateActionToken('accept_deal', payload);
      const [dataB64, sig] = token.split('.');

      // Tamper with data payload
      const tamperedPayload = Buffer.from(JSON.stringify({ dealId: 'hacked-deal', businessId: betaBiz })).toString('base64url');
      const tamperedToken = `${tamperedPayload}.${sig}`;

      assert.throws(() => {
        EmailActionService.verifyActionToken(tamperedToken);
      }, /Cryptographic signature mismatch/i);
    });

    it('should reject expired tokens', () => {
      // Create token that expired 10 seconds ago
      const token = EmailActionService.generateActionToken('accept_deal', { test: true }, -10000);

      assert.throws(() => {
        EmailActionService.verifyActionToken(token);
      }, /Action link has expired/i);
    });
  });

  describe('2. 1-Click Agreement Acceptance via Email', () => {
    let dealId;

    beforeEach(async () => {
      // Create deal using DealService
      const deal = await DealService.createDeal({
        creatorBusinessId: alphaBiz,
        userId: alphaUser.id,
        title: `Email Test Cement Supply ${Date.now()}`,
        description: 'Testing 1-click email acceptance flow',
        amount: 4500000,
        currency: 'NGN',
        termsText: 'Payment upon delivery within 7 working days',
        counterpartyBusinessId: betaBiz
      });

      dealId = deal.id;

      // Creator Alpha accepts first
      await DealService.acceptDeal({
        dealId,
        businessId: alphaBiz,
        userId: alphaUser.id,
        ipAddress: '127.0.0.1'
      });
    });

    it('should accept deal and activate it via GET /actions/accept with magic token', async () => {
      const token = EmailActionService.generateActionToken('accept_deal', {
        dealId,
        businessId: betaBiz,
        userId: betaUser.id
      });

      const res = await apiRequest(`/api/v1/integrations/email/actions/accept?token=${token}`, {
        method: 'GET'
      });

      assert.equal(res.status, 200);
      assert.match(res.data, /Agreement Signed Successfully!/i);
      assert.match(res.data, /Contract is now ACTIVE!/i);

      // Verify deal status changed in database
      const [rows] = await pool.query('SELECT status FROM deals WHERE id = ?', [dealId]);
      assert.equal(rows[0].status, 'active');

      // Verify counterparty acceptance recorded
      const [versions] = await pool.query('SELECT id FROM agreement_versions WHERE deal_id = ?', [dealId]);
      const [accepts] = await pool.query('SELECT * FROM agreement_acceptances WHERE version_id = ? AND business_id = ?', [versions[0].id, betaBiz]);
      assert.equal(accepts.length, 1);
    });

    it('should return HTML error response when invalid token is passed', async () => {
      const res = await apiRequest('/api/v1/integrations/email/actions/accept?token=invalid.token.123', {
        method: 'GET'
      });

      assert.equal(res.status, 400);
      assert.match(res.data, /Action Failed/i);
    });
  });

  describe('3. 1-Click Payment Confirmation via Email', () => {
    let activeDealId, paymentId;

    beforeEach(async () => {
      const deal = await DealService.createDeal({
        creatorBusinessId: alphaBiz,
        userId: alphaUser.id,
        title: `Payment Test Deal ${Date.now()}`,
        description: 'Testing 1-click payment confirmation via email',
        amount: 2000000,
        currency: 'NGN',
        termsText: '50% advance, 50% on delivery',
        counterpartyBusinessId: betaBiz
      });

      activeDealId = deal.id;

      // Both accept to make active
      await DealService.acceptDeal({
        dealId: activeDealId,
        businessId: alphaBiz,
        userId: alphaUser.id
      });
      await DealService.acceptDeal({
        dealId: activeDealId,
        businessId: betaBiz,
        userId: betaUser.id
      });

      paymentId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO payment_records (id, deal_id, reference_no, expected_amount, reported_amount, currency, payer_business_id, recipient_business_id, status, created_at)
         VALUES (?, ?, 'PAY-EMAIL-9988', 2000000, 2000000, 'NGN', ?, ?, 'reported', NOW())`,
        [paymentId, activeDealId, betaBiz, alphaBiz]
      );
    });

    it('should confirm payment receipt via GET /actions/confirm-payment with magic token', async () => {
      const token = EmailActionService.generateActionToken('confirm_payment', {
        dealId: activeDealId,
        paymentId,
        businessId: alphaBiz,
        userId: alphaUser.id
      });

      const res = await apiRequest(`/api/v1/integrations/email/actions/confirm-payment?token=${token}`, {
        method: 'GET'
      });

      assert.equal(res.status, 200);
      assert.match(res.data, /Payment Receipt Confirmed!/i);
      assert.match(res.data, /Funds have been certified on the escrow ledger/i);

      // Verify payment status in DB
      const [rows] = await pool.query('SELECT status FROM payment_records WHERE id = ?', [paymentId]);
      assert.equal(rows[0].status, 'confirmed');
    });
  });

  describe('4. Mock Inbox & Mail Delivery Testing', () => {
    it('should simulate sending an email and track it in mock inbox', async () => {
      const res = await apiRequest('/api/v1/integrations/email/mock-send', {
        method: 'POST',
        body: {
          to: 'partner@lagosdistributors.ng',
          subject: 'Waybill Uploaded for Deal #DW-8821',
          text: 'Waybill proof has been submitted. Please review.',
          actionType: 'accept_deal',
          payload: { dealId: 'deal-xyz', businessId: 'biz-123' }
        }
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.data.sent, true);
      assert.ok(res.data.data.actionUrl.includes('/actions/accept?token='));

      // Check mock inbox
      const inboxRes = await apiRequest('/api/v1/integrations/email/mock-inbox?to=partner@lagosdistributors.ng', {
        method: 'GET'
      });

      assert.equal(inboxRes.status, 200);
      assert.equal(inboxRes.data.data.count, 1);
      assert.equal(inboxRes.data.data.emails[0].subject, 'Waybill Uploaded for Deal #DW-8821');
    });

    it('should clear mock inbox when requested', async () => {
      await emailClient.sendEmail({
        to: 'test@example.com',
        subject: 'Clear test'
      });

      assert.equal(emailClient.getAllMockEmails().length, 1);

      const clearRes = await apiRequest('/api/v1/integrations/email/mock-clear', {
        method: 'POST'
      });

      assert.equal(clearRes.status, 200);
      assert.equal(emailClient.getAllMockEmails().length, 0);
    });
  });

  describe('5. Multi-Channel Unified Dispatcher', () => {
    it('should dispatch multi-channel email notification for deal invitation', async () => {
      emailClient.clearMockInbox();

      const deal = await DealService.createDeal({
        creatorBusinessId: alphaBiz,
        userId: alphaUser.id,
        title: `MC Invitation Test ${Date.now()}`,
        description: 'MultiChannel dispatch verification',
        amount: 12500000,
        currency: 'NGN',
        termsText: 'Supply of 500 Tons Rebar',
        counterpartyBusinessId: betaBiz
      });

      // Explicitly invoke dispatcher
      await MultiChannelNotifier.dispatch('deal.created', {
        deal_id: deal.id
      });

      const emails = emailClient.getMockEmailsFor('procurement@betabuilders.ng');
      assert.ok(emails.length >= 1);
      assert.match(emails[0].subject, /Contract Invitation/i);
      assert.ok(emails[0].actionUrl.includes('/actions/accept?token='));
    });
  });
});
