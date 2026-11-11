import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { startTestServer, stopTestServer, apiRequest } from './testHelper.js';
import pool, { closePool } from '../src/config/db.js';

describe('Tenant Isolation & Deal Access Restriction (/api/v1/deals)', () => {
  let alphaToken = '';
  let betaToken = '';
  let gammaToken = '';
  let individualToken = '';
  let activeDealId = '';

  before(async () => {
    await startTestServer();

    // 1. Login as Alpha Supplies (Creator of Deal 2)
    const alphaLogin = await apiRequest('/api/v1/auth/login', {
      method: 'POST',
      body: {
        email: 'owner@alphasupplies.ng',
        password: 'Password123!'
      }
    });
    alphaToken = alphaLogin.data.data.token;

    // 2. Login as Beta Builders (Counterparty of Deal 2)
    const betaLogin = await apiRequest('/api/v1/auth/login', {
      method: 'POST',
      body: {
        email: 'procurement@betabuilders.ng',
        password: 'Password123!'
      }
    });
    betaToken = betaLogin.data.data.token;

    // 3. Register an unrelated 3rd Tenant: "Gamma Logistics Nigeria Ltd"
    const gammaSuffix = crypto.randomBytes(3).toString('hex');
    const gammaReg = await apiRequest('/api/v1/auth/register', {
      method: 'POST',
      body: {
        email: `director_${gammaSuffix}@gammalogistics.ng`,
        password: 'Password123!',
        full_name: 'Alhaji Sanusi Garba',
        business_name: `Gamma Logistics ${gammaSuffix} Ltd`,
        rc_number: `RC-GAMMA-${gammaSuffix}`,
        address: '22 Wharf Road, Apapa Ports, Lagos'
      }
    });
    gammaToken = gammaReg.data.data.token;

    // 4. Register a user without any business profile
    const indivSuffix = crypto.randomBytes(3).toString('hex');
    const indivReg = await apiRequest('/api/v1/auth/register', {
      method: 'POST',
      body: {
        email: `freelancer_${indivSuffix}@digital.ng`,
        password: 'Password123!',
        full_name: 'Independent Auditor'
      }
    });
    individualToken = indivReg.data.data.token;

    // 5. Query Deal 2 ID from database
    const [deals] = await pool.query(
      "SELECT id FROM deals WHERE reference_no = 'DW-DEAL-2026-0002-ACT'"
    );
    assert.ok(deals.length > 0, 'Seed Deal 2 must exist');
    activeDealId = deals[0].id;
  });

  after(async () => {
    await stopTestServer();
    await closePool();
  });

  describe('Tenant Access to Deal: /api/v1/deals/:dealId', () => {
    it('should GRANT access to Creator business (Alpha Supplies) -> 200 OK', async () => {
      const res = await apiRequest(`/api/v1/deals/${activeDealId}`, {
        token: alphaToken
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.equal(res.data.data.deal.id, activeDealId);
      assert.equal(res.data.data.deal.reference_no, 'DW-DEAL-2026-0002-ACT');
      assert.equal(res.data.data.access_role, 'creator');
      assert.ok(Array.isArray(res.data.data.obligations));
      assert.ok(res.data.data.obligations.length >= 2);
    });

    it('should GRANT access to Counterparty business (Beta Builders) -> 200 OK', async () => {
      const res = await apiRequest(`/api/v1/deals/${activeDealId}`, {
        token: betaToken
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.equal(res.data.data.deal.id, activeDealId);
      assert.equal(res.data.data.deal.reference_no, 'DW-DEAL-2026-0002-ACT');
      assert.equal(res.data.data.access_role, 'counterparty');
    });

    it('should DENY access to Unrelated Third-Party Tenant (Gamma Logistics) -> 403 Forbidden', async () => {
      const res = await apiRequest(`/api/v1/deals/${activeDealId}`, {
        token: gammaToken
      });

      assert.equal(res.status, 403);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'FORBIDDEN');
      assert.match(res.data.error.message, /not an authorized party/i);
    });

    it('should return 404 Not Found when dealId does not exist', async () => {
      const nonExistentDealId = crypto.randomUUID();
      const res = await apiRequest(`/api/v1/deals/${nonExistentDealId}`, {
        token: alphaToken
      });

      assert.equal(res.status, 404);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'DEAL_NOT_FOUND');
    });

    it('should return 401 Unauthorized when request lacks authentication token', async () => {
      const res = await apiRequest(`/api/v1/deals/${activeDealId}`);

      assert.equal(res.status, 401);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'UNAUTHORIZED');
    });

    it('should return 400 when authenticated user has no active business context', async () => {
      const res = await apiRequest(`/api/v1/deals/${activeDealId}`, {
        token: individualToken
      });

      assert.equal(res.status, 400);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'NO_BUSINESS_CONTEXT');
    });
  });

  describe('Tenant Deals List Isolation: GET /api/v1/deals', () => {
    it('should return only deals where caller is creator or counterparty', async () => {
      // Gamma Logistics has 0 deals associated with it
      const gammaDealsRes = await apiRequest('/api/v1/deals', {
        token: gammaToken
      });

      assert.equal(gammaDealsRes.status, 200);
      assert.equal(gammaDealsRes.data.success, true);
      assert.equal(gammaDealsRes.data.data.count, 0);
      assert.deepEqual(gammaDealsRes.data.data.deals, []);

      // Alpha Supplies is creator for Deal 1 and Deal 2
      const alphaDealsRes = await apiRequest('/api/v1/deals?limit=100', {
        token: alphaToken
      });

      assert.equal(alphaDealsRes.status, 200);
      assert.equal(alphaDealsRes.data.success, true);
      assert.ok(alphaDealsRes.data.data.count >= 2);

      const refNos = alphaDealsRes.data.data.deals.map(d => d.reference_no);
      assert.ok(refNos.includes('DW-DEAL-2026-0001-DFT'));
      assert.ok(refNos.includes('DW-DEAL-2026-0002-ACT'));
    });
  });
});
