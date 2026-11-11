import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { startTestServer, stopTestServer, apiRequest } from './testHelper.js';
import pool, { closePool } from '../src/config/db.js';
import ActivityService from '../src/services/activityService.js';

describe('Core Deal Lifecycle & Immutable Audit Trail (/api/v1/deals)', () => {
  let alphaToken = '';
  let betaToken = '';
  let gammaToken = '';

  before(async () => {
    await startTestServer();

    // 1. Login as Alpha Supplies (Supplier / Creator)
    const alphaLogin = await apiRequest('/api/v1/auth/login', {
      method: 'POST',
      body: {
        email: 'owner@alphasupplies.ng',
        password: 'Password123!'
      }
    });
    alphaToken = alphaLogin.data.data.token;

    // 2. Login as Beta Builders (Buyer / Counterparty)
    const betaLogin = await apiRequest('/api/v1/auth/login', {
      method: 'POST',
      body: {
        email: 'procurement@betabuilders.ng',
        password: 'Password123!'
      }
    });
    betaToken = betaLogin.data.data.token;

    // 3. Register Gamma Logistics (3rd party tenant)
    const suffix = crypto.randomBytes(3).toString('hex');
    const gammaReg = await apiRequest('/api/v1/auth/register', {
      method: 'POST',
      body: {
        email: `ops_${suffix}@gammaescrow.ng`,
        password: 'Password123!',
        full_name: 'Gamma Escrow Admin',
        business_name: `Gamma Escrow Services ${suffix}`
      }
    });
    gammaToken = gammaReg.data.data.token;
  });

  after(async () => {
    await stopTestServer();
    await closePool();
  });

  describe('Deal Creation and Invitation Workflow', () => {
    let createdDealId = '';
    let inviteToken = '';

    it('should create a draft deal with initial agreement version 1 and invitation', async () => {
      const payload = {
        title: 'Procurement of Heavy Machinery Hydraulic Cylinders',
        description: 'Supply of 12 industrial-grade high pressure hydraulic cylinders.',
        amount: 8500000.00,
        currency: 'NGN',
        terms_text: 'INITIAL TERMS (V1): Supplier shall deliver within 14 days of mobilization escrow funding.',
        invited_email: 'procurement@betabuilders.ng'
      };

      const res = await apiRequest('/api/v1/deals', {
        method: 'POST',
        body: payload,
        token: alphaToken
      });

      assert.equal(res.status, 201);
      assert.equal(res.data.success, true);
      assert.ok(res.data.data.id);
      assert.equal(res.data.data.status, 'draft');
      assert.equal(res.data.data.current_version, 1);
      assert.equal(res.data.data.agreement_version.version_number, 1);
      assert.equal(res.data.data.agreement_version.terms_text, payload.terms_text);
      assert.ok(res.data.data.invitation);
      assert.equal(res.data.data.invitation.invited_email, 'procurement@betabuilders.ng');

      createdDealId = res.data.data.id;
      inviteToken = res.data.data.invitation.token;
    });

    it('should allow counterparty to accept the invitation and link business', async () => {
      const res = await apiRequest(`/api/v1/deals/invitations/${inviteToken}/accept`, {
        method: 'POST',
        token: betaToken
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.equal(res.data.data.deal_id, createdDealId);
      assert.equal(res.data.data.status, 'accepted');

      // Check deal details
      const dealRes = await apiRequest(`/api/v1/deals/${createdDealId}`, {
        token: alphaToken
      });

      assert.equal(dealRes.status, 200);
      assert.equal(dealRes.data.data.deal.status, 'awaiting_acceptance');
      assert.ok(dealRes.data.data.participants.counterparty);
      assert.equal(dealRes.data.data.participants.counterparty.name, 'Beta Builders Construction Ltd');
    });

    it('should reject re-using an already accepted invitation token', async () => {
      const res = await apiRequest(`/api/v1/deals/invitations/${inviteToken}/accept`, {
        method: 'POST',
        token: gammaToken
      });

      assert.equal(res.status, 400);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'INVITATION_ALREADY_USED');
    });
  });

  describe('Agreement Versioning & Dual Acceptance Rules', () => {
    let dealId = '';

    before(async () => {
      // Create a fresh deal for versioning tests
      const res = await apiRequest('/api/v1/deals', {
        method: 'POST',
        body: {
          title: 'Structural Steel I-Beams (Grade S355)',
          description: 'Supply of 40 metric tons of hot-rolled structural steel.',
          amount: 24000000.00,
          currency: 'NGN',
          terms_text: 'VERSION 1 TERMS: 40% initial escrow, 60% upon delivery inspection.',
          invited_email: 'procurement@betabuilders.ng'
        },
        token: alphaToken
      });

      dealId = res.data.data.id;
      const token = res.data.data.invitation.token;

      // Beta Builders accepts invitation
      await apiRequest(`/api/v1/deals/invitations/${token}/accept`, {
        method: 'POST',
        token: betaToken
      });
    });

    it('RULE 1: Deal must NOT activate when only ONE party has accepted the version', async () => {
      // Creator (Alpha Supplies) accepts version 1
      const acceptRes = await apiRequest(`/api/v1/deals/${dealId}/accept`, {
        method: 'POST',
        token: alphaToken
      });

      assert.equal(acceptRes.status, 200);
      assert.equal(acceptRes.data.success, true);
      assert.equal(acceptRes.data.data.creator_accepted, true);
      assert.equal(acceptRes.data.data.counterparty_accepted, false);
      assert.equal(acceptRes.data.data.activated, false);
      assert.equal(acceptRes.data.data.deal_status, 'awaiting_acceptance');

      // Verify deal status in database is still awaiting_acceptance
      const dealRes = await apiRequest(`/api/v1/deals/${dealId}`, { token: alphaToken });
      assert.equal(dealRes.data.data.deal.status, 'awaiting_acceptance');
      assert.equal(dealRes.data.data.acceptances_status.fully_accepted, false);
    });

    it('RULE 2: Deal AUTOMATICALLY transitions to active when BOTH parties accept matching version', async () => {
      // Counterparty (Beta Builders) accepts version 1
      const acceptRes = await apiRequest(`/api/v1/deals/${dealId}/accept`, {
        method: 'POST',
        token: betaToken
      });

      assert.equal(acceptRes.status, 200);
      assert.equal(acceptRes.data.success, true);
      assert.equal(acceptRes.data.data.creator_accepted, true);
      assert.equal(acceptRes.data.data.counterparty_accepted, true);
      assert.equal(acceptRes.data.data.activated, true);
      assert.equal(acceptRes.data.data.deal_status, 'active');

      // Verify deal status is now active
      const dealRes = await apiRequest(`/api/v1/deals/${dealId}`, { token: betaToken });
      assert.equal(dealRes.data.data.deal.status, 'active');
      assert.equal(dealRes.data.data.acceptances_status.fully_accepted, true);
    });

    it('RULE 3: Editing terms increments version, invalidates previous acceptances, and resets status to awaiting_acceptance', async () => {
      const updatedTerms = 'VERSION 2 REVISED TERMS: 50% mobilization, 50% upon QA lab cert sign-off.';

      const updateRes = await apiRequest(`/api/v1/deals/${dealId}/terms`, {
        method: 'PUT',
        body: { terms_text: updatedTerms },
        token: betaToken
      });

      assert.equal(updateRes.status, 200);
      assert.equal(updateRes.data.success, true);
      assert.equal(updateRes.data.data.previous_version, 1);
      assert.equal(updateRes.data.data.current_version, 2);
      assert.equal(updateRes.data.data.status, 'awaiting_acceptance');
      assert.equal(updateRes.data.data.version.version_number, 2);

      // Verify previous acceptances are no longer valid for version 2
      const dealRes = await apiRequest(`/api/v1/deals/${dealId}`, { token: alphaToken });
      assert.equal(dealRes.data.data.deal.current_version, 2);
      assert.equal(dealRes.data.data.deal.status, 'awaiting_acceptance');
      assert.equal(dealRes.data.data.acceptances_status.version_number, 2);
      assert.equal(dealRes.data.data.acceptances_status.creator_accepted, false);
      assert.equal(dealRes.data.data.acceptances_status.counterparty_accepted, false);
      assert.equal(dealRes.data.data.acceptances_status.fully_accepted, false);
    });

    it('RULE 4: Deal will NOT reactivate if only one party accepts the newly revised version 2', async () => {
      // Beta Builders accepts version 2
      const acceptRes = await apiRequest(`/api/v1/deals/${dealId}/accept`, {
        method: 'POST',
        token: betaToken
      });

      assert.equal(acceptRes.status, 200);
      assert.equal(acceptRes.data.data.version_number, 2);
      assert.equal(acceptRes.data.data.counterparty_accepted, true);
      assert.equal(acceptRes.data.data.creator_accepted, false);
      assert.equal(acceptRes.data.data.activated, false);

      const dealRes = await apiRequest(`/api/v1/deals/${dealId}`, { token: betaToken });
      assert.equal(dealRes.data.data.deal.status, 'awaiting_acceptance');
    });

    it('RULE 5: Deal reactivates when the second party accepts the matching version 2', async () => {
      // Alpha Supplies accepts version 2
      const acceptRes = await apiRequest(`/api/v1/deals/${dealId}/accept`, {
        method: 'POST',
        token: alphaToken
      });

      assert.equal(acceptRes.status, 200);
      assert.equal(acceptRes.data.data.version_number, 2);
      assert.equal(acceptRes.data.data.counterparty_accepted, true);
      assert.equal(acceptRes.data.data.creator_accepted, true);
      assert.equal(acceptRes.data.data.activated, true);
      assert.equal(acceptRes.data.data.deal_status, 'active');

      const dealRes = await apiRequest(`/api/v1/deals/${dealId}`, { token: alphaToken });
      assert.equal(dealRes.data.data.deal.status, 'active');
      assert.equal(dealRes.data.data.acceptances_status.fully_accepted, true);
    });
  });

  describe('Explicit State Transition Guards', () => {
    let dealId = '';

    before(async () => {
      // Create an active deal
      const res = await apiRequest('/api/v1/deals', {
        method: 'POST',
        body: {
          title: 'Roofing Truss Fabrication and Erection',
          amount: 12000000.00,
          currency: 'NGN',
          terms_text: 'Complete fabrication and truss installation on Lekki Warehouse.',
          invited_email: 'procurement@betabuilders.ng'
        },
        token: alphaToken
      });

      dealId = res.data.data.id;
      const inviteToken = res.data.data.invitation.token;

      await apiRequest(`/api/v1/deals/invitations/${inviteToken}/accept`, {
        method: 'POST',
        token: betaToken
      });

      // Dual accept to reach 'active'
      await apiRequest(`/api/v1/deals/${dealId}/accept`, { method: 'POST', token: alphaToken });
      await apiRequest(`/api/v1/deals/${dealId}/accept`, { method: 'POST', token: betaToken });
    });

    it('GUARD 1: Manual transition to active status is forbidden (dual acceptance required)', async () => {
      const res = await apiRequest(`/api/v1/deals/${dealId}/transition`, {
        method: 'POST',
        body: { target_status: 'active' },
        token: alphaToken
      });

      assert.equal(res.status, 400);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'ACTIVATION_REQUIRES_DUAL_ACCEPTANCE');
    });

    it('GUARD 2: Cannot complete a deal while unresolved disputes are open', async () => {
      // Insert an open dispute on this deal in database
      const disputeId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO disputes (
          id, deal_id, raised_by_business_id, category, description, status, created_at, updated_at
        ) VALUES (?, ?, (SELECT counterparty_business_id FROM deals WHERE id = ?), 'Quality Defect', 'Truss welding joint failure', 'open', NOW(), NOW())`,
        [disputeId, dealId, dealId]
      );

      // Attempt to complete deal
      const completeRes = await apiRequest(`/api/v1/deals/${dealId}/complete`, {
        method: 'POST',
        body: { reason: 'Work finished' },
        token: alphaToken
      });

      assert.equal(completeRes.status, 400);
      assert.equal(completeRes.data.success, false);
      assert.equal(completeRes.data.error.code, 'OPEN_DISPUTES_EXIST');

      // Now resolve the dispute and reconcile payment ledger
      await pool.query(
        "UPDATE disputes SET status = 'resolved', resolved_at = NOW() WHERE id = ?",
        [disputeId]
      );
      await pool.query(
        `INSERT INTO payment_records (
          id, deal_id, expected_amount, reported_amount, currency, payment_method,
          status, paid_at, confirmed_at, payer_business_id, recipient_business_id, reference_no, created_at
        ) VALUES (UUID(), ?, 12000000.00, 12000000.00, 'NGN', 'bank_transfer', 'confirmed', NOW(), NOW(), (SELECT counterparty_business_id FROM deals WHERE id = ?), (SELECT creator_business_id FROM deals WHERE id = ?), 'TEST-SETTLE-01', NOW())`,
        [dealId, dealId, dealId]
      );

      // Attempt to complete deal again -> Should succeed!
      const retryCompleteRes = await apiRequest(`/api/v1/deals/${dealId}/complete`, {
        method: 'POST',
        body: { reason: 'Dispute resolved and final inspection passed' },
        token: alphaToken
      });

      assert.equal(retryCompleteRes.status, 200);
      assert.equal(retryCompleteRes.data.success, true);
      assert.equal(retryCompleteRes.data.data.status, 'completed');
    });

    it('GUARD 3: Completed deal is locked against modification of terms', async () => {
      const res = await apiRequest(`/api/v1/deals/${dealId}/terms`, {
        method: 'PUT',
        body: { terms_text: 'Unauthorized change after completion' },
        token: alphaToken
      });

      assert.equal(res.status, 400);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'DEAL_LOCKED');
    });
  });

  describe('Immutable Activity Timeline (/api/v1/deals/:dealId/activity)', () => {
    let dealId = '';

    before(async () => {
      const res = await apiRequest('/api/v1/deals', {
        method: 'POST',
        body: {
          title: 'HVAC Air Chillers Installation',
          amount: 15000000.00,
          currency: 'NGN',
          terms_text: 'HVAC installation warranty 2 years.',
          invited_email: 'procurement@betabuilders.ng'
        },
        token: alphaToken
      });

      dealId = res.data.data.id;
      const inviteToken = res.data.data.invitation.token;

      await apiRequest(`/api/v1/deals/invitations/${inviteToken}/accept`, {
        method: 'POST',
        token: betaToken
      });

      await apiRequest(`/api/v1/deals/${dealId}/accept`, { method: 'POST', token: alphaToken });
      await apiRequest(`/api/v1/deals/${dealId}/accept`, { method: 'POST', token: betaToken });
      await apiRequest(`/api/v1/deals/${dealId}/terms`, {
        method: 'PUT',
        body: { terms_text: 'Updated chiller terms' },
        token: alphaToken
      });
    });

    it('should retrieve chronological audit trail with actors and event payloads', async () => {
      const res = await apiRequest(`/api/v1/deals/${dealId}/activity`, {
        token: alphaToken
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.ok(Array.isArray(res.data.data.timeline));
      assert.ok(res.data.data.count >= 4);

      const eventTypes = res.data.data.timeline.map(t => t.event_type);
      assert.ok(eventTypes.includes('deal.created'));
      assert.ok(eventTypes.includes('deal.invitation_sent'));
      assert.ok(eventTypes.includes('deal.invitation_accepted'));
      assert.ok(eventTypes.includes('deal.accepted'));
      assert.ok(eventTypes.includes('deal.activated'));
      assert.ok(eventTypes.includes('terms.updated'));
    });

    it('should disallow update or deletion of activity records (Immutability guarantee)', async () => {
      await assert.rejects(
        async () => {
          await ActivityService.updateEvent();
        },
        (err) => {
          assert.equal(err.code, 'AUDIT_IMMUTABLE');
          return true;
        }
      );

      await assert.rejects(
        async () => {
          await ActivityService.deleteEvent();
        },
        (err) => {
          assert.equal(err.code, 'AUDIT_IMMUTABLE');
          return true;
        }
      );
    });
  });

  describe('Deals Listing with Status Filter and Pagination', () => {
    it('should filter deals by status and return pagination metadata', async () => {
      const res = await apiRequest('/api/v1/deals?status=active&limit=5&page=1', {
        token: alphaToken
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.ok(typeof res.data.data.total === 'number');
      assert.ok(Array.isArray(res.data.data.deals));

      for (const d of res.data.data.deals) {
        assert.equal(d.status, 'active');
      }
    });
  });
});
