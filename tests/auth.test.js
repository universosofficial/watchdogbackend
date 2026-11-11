import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { startTestServer, stopTestServer, apiRequest } from './testHelper.js';
import { closePool } from '../src/config/db.js';

describe('Authentication & User Management Endpoints (/api/v1/auth)', () => {
  before(async () => {
    await startTestServer();
  });

  after(async () => {
    await stopTestServer();
    await closePool();
  });

  describe('POST /api/v1/auth/register', () => {
    it('should register a new user along with an initial business profile', async () => {
      const uniqueSuffix = crypto.randomBytes(4).toString('hex');
      const payload = {
        email: `new_founder_${uniqueSuffix}@techtrade.ng`,
        password: 'Password123!',
        full_name: 'Babajide Ogundimu',
        phone: `+23480${crypto.randomInt(10000000, 99999999)}`,
        business_name: `TechTrade Global ${uniqueSuffix} Ltd`,
        rc_number: `RC-${uniqueSuffix.toUpperCase()}`,
        address: '5 Commercial Road, Victoria Island, Lagos'
      };

      const res = await apiRequest('/api/v1/auth/register', {
        method: 'POST',
        body: payload
      });

      assert.equal(res.status, 201);
      assert.equal(res.data.success, true);
      assert.ok(res.data.data.user);
      assert.equal(res.data.data.user.email, payload.email.toLowerCase());
      assert.ok(res.data.data.business);
      assert.equal(res.data.data.business.name, payload.business_name);
      assert.equal(res.data.data.business.role, 'owner');
      assert.ok(res.data.data.token, 'Should return signed JWT');
    });

    it('should register a user without a business profile', async () => {
      const uniqueSuffix = crypto.randomBytes(4).toString('hex');
      const payload = {
        email: `individual_${uniqueSuffix}@consultant.ng`,
        password: 'SecurePassword123!',
        full_name: 'Nkechi Obi',
        phone: `+23480${crypto.randomInt(10000000, 99999999)}`
      };

      const res = await apiRequest('/api/v1/auth/register', {
        method: 'POST',
        body: payload
      });

      assert.equal(res.status, 201);
      assert.equal(res.data.success, true);
      assert.equal(res.data.data.business, null);
      assert.ok(res.data.data.token);
    });

    it('should reject registration when required fields are missing', async () => {
      const res = await apiRequest('/api/v1/auth/register', {
        method: 'POST',
        body: { email: 'incomplete@user.ng' }
      });

      assert.equal(res.status, 400);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'MISSING_REQUIRED_FIELDS');
    });

    it('should reject invalid email formatting', async () => {
      const res = await apiRequest('/api/v1/auth/register', {
        method: 'POST',
        body: {
          email: 'not-an-email',
          password: 'Password123!',
          full_name: 'Test Name'
        }
      });

      assert.equal(res.status, 400);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'INVALID_EMAIL_FORMAT');
    });

    it('should reject password shorter than 8 characters', async () => {
      const res = await apiRequest('/api/v1/auth/register', {
        method: 'POST',
        body: {
          email: 'shortpass@trade.ng',
          password: 'short',
          full_name: 'Short Password User'
        }
      });

      assert.equal(res.status, 400);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'PASSWORD_TOO_SHORT');
    });

    it('should prevent duplicate email registration', async () => {
      // Use existing seeded user email
      const res = await apiRequest('/api/v1/auth/register', {
        method: 'POST',
        body: {
          email: 'owner@alphasupplies.ng',
          password: 'AnotherPassword123!',
          full_name: 'Duplicate Attempt'
        }
      });

      assert.equal(res.status, 409);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'EMAIL_ALREADY_EXISTS');
    });
  });

  describe('POST /api/v1/auth/login', () => {
    it('should authenticate seeded user and return JWT with primary business context', async () => {
      const res = await apiRequest('/api/v1/auth/login', {
        method: 'POST',
        body: {
          email: 'owner@alphasupplies.ng',
          password: 'Password123!'
        }
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.ok(res.data.data.token);
      assert.equal(res.data.data.user.email, 'owner@alphasupplies.ng');
      assert.ok(res.data.data.business);
      assert.equal(res.data.data.business.name, 'Alpha Supplies Nigeria Ltd');
      assert.equal(res.data.data.business.role, 'owner');
    });

    it('should reject login with wrong password', async () => {
      const res = await apiRequest('/api/v1/auth/login', {
        method: 'POST',
        body: {
          email: 'owner@alphasupplies.ng',
          password: 'IncorrectPassword999!'
        }
      });

      assert.equal(res.status, 401);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'INVALID_CREDENTIALS');
    });

    it('should reject login for non-existent email', async () => {
      const res = await apiRequest('/api/v1/auth/login', {
        method: 'POST',
        body: {
          email: 'ghost_user@nonexistent.ng',
          password: 'Password123!'
        }
      });

      assert.equal(res.status, 401);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'INVALID_CREDENTIALS');
    });
  });

  describe('GET /api/v1/auth/me', () => {
    it('should return user details and associated businesses when authenticated', async () => {
      // First login
      const loginRes = await apiRequest('/api/v1/auth/login', {
        method: 'POST',
        body: {
          email: 'owner@alphasupplies.ng',
          password: 'Password123!'
        }
      });
      const token = loginRes.data.data.token;

      // Query /me
      const meRes = await apiRequest('/api/v1/auth/me', { token });

      assert.equal(meRes.status, 200);
      assert.equal(meRes.data.success, true);
      assert.equal(meRes.data.data.user.email, 'owner@alphasupplies.ng');
      assert.ok(Array.isArray(meRes.data.data.businesses));
      assert.ok(meRes.data.data.businesses.length >= 1);
    });

    it('should return 401 Unauthorized when token is missing', async () => {
      const res = await apiRequest('/api/v1/auth/me');
      assert.equal(res.status, 401);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'UNAUTHORIZED');
    });

    it('should return 401 Unauthorized when token is invalid', async () => {
      const res = await apiRequest('/api/v1/auth/me', { token: 'invalid.jwt.token' });
      assert.equal(res.status, 401);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'TOKEN_INVALID');
    });
  });

  describe('POST /api/v1/auth/switch-business', () => {
    it('should reject switching to a business the user does not belong to', async () => {
      // Login as Beta Builders user
      const loginRes = await apiRequest('/api/v1/auth/login', {
        method: 'POST',
        body: {
          email: 'procurement@betabuilders.ng',
          password: 'Password123!'
        }
      });
      const token = loginRes.data.data.token;

      // Try switching to a bogus or unauthorized business ID
      const fakeBusinessId = crypto.randomUUID();
      const res = await apiRequest('/api/v1/auth/switch-business', {
        method: 'POST',
        body: { business_id: fakeBusinessId },
        token
      });

      assert.equal(res.status, 403);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'FORBIDDEN_BUSINESS_ACCESS');
    });

    it('should switch business context and issue new token when user is a legitimate member', async () => {
      // Register user with primary business
      const suffix = crypto.randomBytes(3).toString('hex');
      const regRes = await apiRequest('/api/v1/auth/register', {
        method: 'POST',
        body: {
          email: `multi_corp_${suffix}@holding.ng`,
          password: 'Password123!',
          full_name: 'Chief Alabi',
          business_name: `Holding Corp ${suffix}`
        }
      });

      const token1 = regRes.data.data.token;
      const user = regRes.data.data.user;

      // Directly add membership to a second business in database for this user
      const { default: pool } = await import('../src/config/db.js');
      const secondBizId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO businesses (id, name, rc_number, address, verification_status)
         VALUES (?, ?, ?, ?, 'verified')`,
        [secondBizId, `Second Venture ${suffix} Ltd`, `RC-SEC-${suffix}`, '10 Marina, Lagos']
      );
      await pool.query(
        `INSERT INTO business_members (id, user_id, business_id, role)
         VALUES (?, ?, ?, 'staff')`,
        [crypto.randomUUID(), user.id, secondBizId]
      );

      // Now call switch-business
      const switchRes = await apiRequest('/api/v1/auth/switch-business', {
        method: 'POST',
        body: { business_id: secondBizId },
        token: token1
      });

      assert.equal(switchRes.status, 200);
      assert.equal(switchRes.data.success, true);
      assert.equal(switchRes.data.data.business.id, secondBizId);
      assert.equal(switchRes.data.data.business.role, 'staff');
      assert.ok(switchRes.data.data.token);

      // Verify that new token reflects the switched business ID
      const meRes = await apiRequest('/api/v1/auth/me', {
        token: switchRes.data.data.token
      });
      assert.equal(meRes.status, 200);
      assert.equal(meRes.data.data.active_business_id, secondBizId);
      assert.equal(meRes.data.data.active_role, 'staff');
    });
  });
});
