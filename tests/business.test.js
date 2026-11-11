import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { startTestServer, stopTestServer, apiRequest } from './testHelper.js';
import { closePool } from '../src/config/db.js';

describe('Business Management & Onboarding Endpoints (/api/v1/businesses)', () => {
  let ownerToken = '';
  let staffToken = '';
  let businessId = '';

  before(async () => {
    await startTestServer();

    // Register a new business owner
    const suffix = crypto.randomBytes(3).toString('hex');
    const ownerRes = await apiRequest('/api/v1/auth/register', {
      method: 'POST',
      body: {
        email: `biz_owner_${suffix}@enterprises.ng`,
        password: 'Password123!',
        full_name: 'Dr. Emeka Eze',
        business_name: `Eze Group ${suffix} Ltd`,
        rc_number: `RC-EZE-${suffix}`,
        address: '12 Admiralty Way, Lekki Phase 1, Lagos'
      }
    });

    ownerToken = ownerRes.data.data.token;
    businessId = ownerRes.data.data.business.id;

    // Add a staff member to Eze Group
    const staffEmail = `staff_member_${suffix}@enterprises.ng`;
    const inviteRes = await apiRequest('/api/v1/businesses/members', {
      method: 'POST',
      body: {
        email: staffEmail,
        role: 'staff',
        full_name: 'Chinedu Eze'
      },
      token: ownerToken
    });

    // Also log in as staff member or switch to get a valid staff token
    const { signToken } = await import('../src/utils/jwt.js');
    staffToken = signToken({
      userId: inviteRes.data.data.user_id,
      businessId,
      role: 'staff'
    });
  });

  after(async () => {
    await stopTestServer();
    await closePool();
  });

  describe('GET /api/v1/businesses/me', () => {
    it('should return current business profile for authenticated owner', async () => {
      const res = await apiRequest('/api/v1/businesses/me', { token: ownerToken });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.equal(res.data.data.id, businessId);
      assert.equal(res.data.data.current_user_role, 'owner');
      assert.ok(res.data.data.verification_status);
    });

    it('should reject unauthenticated requests with 401', async () => {
      const res = await apiRequest('/api/v1/businesses/me');
      assert.equal(res.status, 401);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'UNAUTHORIZED');
    });
  });

  describe('PUT /api/v1/businesses/me', () => {
    it('should allow owner to update business address and details', async () => {
      const updatedAddress = 'Plot 99, Victoria Island Commercial District, Lagos';
      const res = await apiRequest('/api/v1/businesses/me', {
        method: 'PUT',
        body: {
          address: updatedAddress
        },
        token: ownerToken
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.equal(res.data.data.address, updatedAddress);
    });

    it('should forbid staff members from updating business details', async () => {
      const res = await apiRequest('/api/v1/businesses/me', {
        method: 'PUT',
        body: {
          name: 'Hacked Name By Staff'
        },
        token: staffToken
      });

      assert.equal(res.status, 403);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'FORBIDDEN');
    });
  });

  describe('GET /api/v1/businesses/members', () => {
    it('should list all members of the active business', async () => {
      const res = await apiRequest('/api/v1/businesses/members', { token: ownerToken });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.ok(res.data.data.count >= 2);
      assert.ok(Array.isArray(res.data.data.members));

      const roles = res.data.data.members.map(m => m.role);
      assert.ok(roles.includes('owner'));
      assert.ok(roles.includes('staff'));
    });
  });

  describe('POST /api/v1/businesses/members', () => {
    it('should allow owner to invite another staff member', async () => {
      const newEmail = `accountant_${crypto.randomBytes(3).toString('hex')}@enterprises.ng`;
      const res = await apiRequest('/api/v1/businesses/members', {
        method: 'POST',
        body: {
          email: newEmail,
          role: 'staff',
          full_name: 'Lead Accountant'
        },
        token: ownerToken
      });

      assert.equal(res.status, 201);
      assert.equal(res.data.success, true);
      assert.equal(res.data.data.email, newEmail.toLowerCase());
      assert.equal(res.data.data.role, 'staff');
    });

    it('should reject inviting someone who is already a member', async () => {
      // Fetch members first
      const listRes = await apiRequest('/api/v1/businesses/members', { token: ownerToken });
      const existingEmail = listRes.data.data.members[0].email;

      const res = await apiRequest('/api/v1/businesses/members', {
        method: 'POST',
        body: {
          email: existingEmail,
          role: 'staff'
        },
        token: ownerToken
      });

      assert.equal(res.status, 409);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'MEMBER_ALREADY_EXISTS');
    });

    it('should forbid staff members from inviting new members', async () => {
      const res = await apiRequest('/api/v1/businesses/members', {
        method: 'POST',
        body: {
          email: 'unauthorized_invite@enterprises.ng',
          role: 'staff'
        },
        token: staffToken
      });

      assert.equal(res.status, 403);
      assert.equal(res.data.success, false);
      assert.equal(res.data.error.code, 'FORBIDDEN');
    });
  });
});
