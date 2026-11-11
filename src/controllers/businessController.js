import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import pool, { getConnection } from '../config/db.js';
import { sendSuccess, sendError } from '../utils/response.js';

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);

/**
 * GET /api/v1/businesses/me
 * Retrieves current business profile and verification status
 */
export async function getCurrentBusiness(req, res) {
  try {
    const businessId = req.businessId;

    const [businesses] = await pool.query(
      `SELECT 
        id,
        name,
        rc_number,
        address,
        verification_status,
        created_at,
        updated_at
      FROM businesses
      WHERE id = ?`,
      [businessId]
    );

    if (businesses.length === 0) {
      return sendError(res, 'Active business profile not found', 'BUSINESS_NOT_FOUND', 404);
    }

    const business = businesses[0];
    business.current_user_role = req.role;

    return sendSuccess(res, business);
  } catch (error) {
    console.error('[GetCurrentBusiness Error]:', error);
    return sendError(res, 'Failed to fetch business details', 'INTERNAL_ERROR', 500);
  }
}

/**
 * PUT /api/v1/businesses/me
 * Update business details (address, RC number, name)
 */
export async function updateCurrentBusiness(req, res) {
  const businessId = req.businessId;
  const { name, rc_number, address } = req.body;

  // Only business owner can update business profile
  if (req.role !== 'owner') {
    return sendError(
      res,
      'Unauthorized: Only business owners can update company profile information',
      'FORBIDDEN',
      403
    );
  }

  try {
    const [businesses] = await pool.query('SELECT * FROM businesses WHERE id = ?', [businessId]);
    if (businesses.length === 0) {
      return sendError(res, 'Business profile not found', 'BUSINESS_NOT_FOUND', 404);
    }

    const current = businesses[0];
    const updatedName = name ? name.trim() : current.name;
    const updatedRc = rc_number !== undefined ? (rc_number ? rc_number.trim() : null) : current.rc_number;
    const updatedAddress = address !== undefined ? (address ? address.trim() : null) : current.address;

    await pool.query(
      `UPDATE businesses 
       SET name = ?, rc_number = ?, address = ?, updated_at = NOW()
       WHERE id = ?`,
      [updatedName, updatedRc, updatedAddress, businessId]
    );

    const [updated] = await pool.query('SELECT * FROM businesses WHERE id = ?', [businessId]);

    return sendSuccess(res, updated[0], 200);
  } catch (error) {
    console.error('[UpdateBusiness Error]:', error);
    return sendError(res, 'Failed to update business profile', 'UPDATE_FAILED', 500);
  }
}

/**
 * GET /api/v1/businesses/members
 * Lists team members of the active business
 */
export async function listMembers(req, res) {
  const businessId = req.businessId;

  try {
    const [members] = await pool.query(
      `SELECT 
        bm.id AS membership_id,
        bm.role,
        bm.created_at AS joined_at,
        u.id AS user_id,
        u.email,
        u.full_name,
        u.phone
      FROM business_members bm
      INNER JOIN users u ON bm.user_id = u.id
      WHERE bm.business_id = ?
      ORDER BY FIELD(bm.role, 'owner', 'staff'), bm.created_at ASC`,
      [businessId]
    );

    return sendSuccess(res, {
      count: members.length,
      members
    });
  } catch (error) {
    console.error('[ListMembers Error]:', error);
    return sendError(res, 'Failed to retrieve team members', 'INTERNAL_ERROR', 500);
  }
}

/**
 * POST /api/v1/businesses/members
 * Invites or adds a member (staff/owner) to the active business
 */
export async function inviteMember(req, res) {
  const businessId = req.businessId;
  const { email, role = 'staff', full_name, phone } = req.body;

  if (req.role !== 'owner') {
    return sendError(res, 'Only business owners can invite or add team members', 'FORBIDDEN', 403);
  }

  if (!email) {
    return sendError(res, 'Member email is required', 'MISSING_EMAIL', 400);
  }

  const validRoles = ['owner', 'staff'];
  if (!validRoles.includes(role)) {
    return sendError(res, "Invalid role. Role must be 'owner' or 'staff'", 'INVALID_ROLE', 400);
  }

  const normalizedEmail = email.trim().toLowerCase();
  const conn = await getConnection();

  try {
    await conn.beginTransaction();

    // Check if user already exists
    let [users] = await conn.query('SELECT id, email, full_name FROM users WHERE email = ?', [normalizedEmail]);
    let targetUserId;

    if (users.length > 0) {
      targetUserId = users[0].id;

      // Check if already a member
      const [existingMembership] = await conn.query(
        'SELECT id, role FROM business_members WHERE business_id = ? AND user_id = ?',
        [businessId, targetUserId]
      );

      if (existingMembership.length > 0) {
        await conn.rollback();
        return sendError(res, 'User is already a member of this business', 'MEMBER_ALREADY_EXISTS', 409);
      }
    } else {
      // Create user account with a secure temporary password
      targetUserId = crypto.randomUUID();
      const tempPassword = `DW_${crypto.randomBytes(8).toString('hex')}!`;
      const passwordHash = await bcrypt.hash(tempPassword, BCRYPT_ROUNDS);
      const memberPhone = phone ? String(phone).trim() : `+23490${crypto.randomInt(10000000, 99999999)}`;

      await conn.query(
        `INSERT INTO users (id, email, password_hash, full_name, phone, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
        [targetUserId, normalizedEmail, passwordHash, full_name ? full_name.trim() : normalizedEmail.split('@')[0], memberPhone]
      );
    }

    // Add membership
    const membershipId = crypto.randomUUID();
    await conn.query(
      `INSERT INTO business_members (id, user_id, business_id, role, created_at)
       VALUES (?, ?, ?, ?, NOW())`,
      [membershipId, targetUserId, businessId, role]
    );

    await conn.commit();

    return sendSuccess(
      res,
      {
        membership_id: membershipId,
        user_id: targetUserId,
        email: normalizedEmail,
        role,
        business_id: businessId,
        status: 'active'
      },
      201
    );
  } catch (error) {
    await conn.rollback();
    console.error('[InviteMember Error]:', error);
    return sendError(res, 'Failed to invite or add member to business', 'INVITE_FAILED', 500);
  } finally {
    conn.release();
  }
}
