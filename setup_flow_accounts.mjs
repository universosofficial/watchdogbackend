import dotenv from 'dotenv';
dotenv.config();
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import pool from './src/config/db.js';
import SmsService from './src/services/integrations/smsService.js';

async function setupAccounts() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const passwordHash = await bcrypt.hash('Password123!', 10);

    const accounts = [
      {
        phone: '08098765432',
        fullName: 'Musa Abubakar',
        email: 'seller@abubakarsupplies.ng',
        persona: 'seller',
        bizName: 'Abubakar Commercial Supplies Ltd',
        rcNumber: 'RC-9988221',
        isBankVerified: 1,
        bankName: 'Guaranty Trust Bank',
        bankCode: '058',
        accountNumber: '0123456789',
        accountName: 'MUSA ABUBAKAR',
        tier: 'tier_2'
      },
      {
        phone: '08012345678',
        fullName: 'Ngozi Eze',
        email: 'buyer@ezeretail.ng',
        persona: 'buyer',
        bizName: 'Eze Retail Ventures',
        rcNumber: null,
        isBankVerified: 0,
        bankName: null,
        bankCode: null,
        accountNumber: null,
        accountName: null,
        tier: 'tier_1'
      }
    ];

    for (const acc of accounts) {
      const normalizedPhone = SmsService.normalizePhoneNumber(acc.phone);
      console.log(`Setting up account: ${acc.fullName} (${normalizedPhone})...`);

      // Check if user exists
      const [existingUsers] = await conn.query('SELECT id FROM users WHERE phone = ?', [normalizedPhone]);
      let userId;

      if (existingUsers.length > 0) {
        userId = existingUsers[0].id;
        await conn.query(
          `UPDATE users SET full_name = ?, password_hash = ?, active_persona = ?, email = ? WHERE id = ?`,
          [acc.fullName, passwordHash, acc.persona, acc.email, userId]
        );
        console.log(`  Updated existing user: ${userId}`);
      } else {
        userId = crypto.randomUUID();
        await conn.query(
          `INSERT INTO users (id, phone, email, password_hash, full_name, active_persona, phone_verified_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
          [userId, normalizedPhone, acc.email, passwordHash, acc.fullName, acc.persona]
        );
        console.log(`  Created new user: ${userId}`);
      }

      // Check if business exists for user
      const [memberships] = await conn.query('SELECT business_id FROM business_members WHERE user_id = ?', [userId]);
      let businessId;

      if (memberships.length > 0) {
        businessId = memberships[0].business_id;
        await conn.query(
          `UPDATE businesses 
           SET name = ?, rc_number = ?, is_bank_verified = ?, bank_name = ?, bank_code = ?, 
               verified_account_number = ?, verified_account_name = ?, business_tier = ?,
               is_biometric_verified = ?, verification_status = ?
           WHERE id = ?`,
          [
            acc.bizName,
            acc.rcNumber,
            acc.isBankVerified,
            acc.bankName,
            acc.bankCode,
            acc.accountNumber,
            acc.accountName,
            acc.tier,
            acc.isBankVerified,
            acc.isBankVerified ? 'verified' : 'unverified',
            businessId
          ]
        );
        console.log(`  Updated business: ${acc.bizName} (${businessId})`);
      } else {
        businessId = crypto.randomUUID();
        await conn.query(
          `INSERT INTO businesses (id, name, rc_number, is_bank_verified, bank_name, bank_code, verified_account_number, verified_account_name, business_tier, is_biometric_verified, verification_status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
          [
            businessId,
            acc.bizName,
            acc.rcNumber,
            acc.isBankVerified,
            acc.bankName,
            acc.bankCode,
            acc.accountNumber,
            acc.accountName,
            acc.tier,
            acc.isBankVerified,
            acc.isBankVerified ? 'verified' : 'unverified'
          ]
        );
        const memberId = crypto.randomUUID();
        await conn.query(
          `INSERT INTO business_members (id, user_id, business_id, role, created_at)
           VALUES (?, ?, ?, 'owner', NOW())`,
          [memberId, userId, businessId]
        );
        console.log(`  Created business & membership: ${acc.bizName} (${businessId})`);
      }
    }

    await conn.commit();
    console.log('\nSUCCESS! Both accounts are ready for practical userflow testing.');
  } catch (err) {
    await conn.rollback();
    console.error('Setup failed:', err);
  } finally {
    conn.release();
    process.exit();
  }
}

setupAccounts();
